import type { Clock, TimerHandle } from '../clock.js';
import { between, deriveSeed, mulberry32, shuffle } from '../rng.js';
import {
  CLOSE_LOGGED_OUT,
  type Credentials,
  type Listener,
  type OutboundMessage,
  type ProviderEvent,
  type ProviderEventMap,
  type SendResult,
  type SessionDescriptor,
  type SessionProvider,
} from './types.js';

/**
 * Scripted failure scenarios. Each one reproduces a failure mode that
 * multi-session setups run into; the simulator decides *when* from the seed.
 */
export type Scenario =
  | 'healthy'
  | 'silent_drop'
  | 'logged_out'
  | 'credential_error_loop'
  | 'stuck_reconnecting'
  | 'never_acked';

/** Default fault mix for a 40-session fleet (the rest are healthy). */
export const DEFAULT_MIX: Record<Exclude<Scenario, 'healthy'>, number> = {
  silent_drop: 4,
  logged_out: 2,
  credential_error_loop: 2,
  stuck_reconnecting: 2,
  never_acked: 3,
};

export interface SimulatedProviderOptions {
  clock: Clock;
  seed?: number;
  sessionCount?: number;
  heartbeatIntervalMs?: number;
  mix?: Partial<Record<Exclude<Scenario, 'healthy'>, number>>;
  /** Force specific sessions into a scenario (used by tests). */
  overrides?: Record<string, Scenario>;
  /** Fault timing window, ms after provider creation. */
  faultWindowMs?: { min: number; max: number };
}

interface Connection {
  generation: number;
  open: boolean;
  /** Silent drop: socket looks open locally but nothing gets through. */
  silent: boolean;
  timers: TimerHandle[];
  heartbeat?: TimerHandle;
}

interface SimSession {
  desc: SessionDescriptor;
  scenario: Scenario;
  rand: () => number;
  ackRand: () => number;
  conn: Connection | null;
  /** Credentials generation the scripted fault applies to (null = no fault yet). */
  faultGeneration: number | null;
  faultAt: number | null;
  /** never_acked: from this time on, nothing gets a delivery ack. */
  acksStopped: boolean;
  msgSeq: number;
  lastGeneration: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

export class SimulatedProvider implements SessionProvider {
  readonly name = 'simulated';
  private readonly clock: Clock;
  private readonly heartbeatIntervalMs: number;
  private readonly sessions = new Map<string, SimSession>();
  private readonly listeners: { [E in ProviderEvent]: Set<Listener<E>> } = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    ack: new Set(),
    heartbeat: new Set(),
  };
  private readonly globalTimers: TimerHandle[] = [];

  constructor(opts: SimulatedProviderOptions) {
    this.clock = opts.clock;
    const seed = opts.seed ?? 42;
    const count = opts.sessionCount ?? 40;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 5_000;
    const window = opts.faultWindowMs ?? { min: 60_000, max: 240_000 };
    const mix = { ...DEFAULT_MIX, ...(opts.mix ?? {}) };

    const ids = Array.from({ length: count }, (_, i) => `s${pad(i + 1)}`);
    const scenarioById = new Map<string, Scenario>();
    const order = shuffle(ids, mulberry32(deriveSeed(seed, 'assign')));
    let cursor = 0;
    for (const [scenario, n] of Object.entries(mix) as [Scenario, number][]) {
      const scaled = count === 40 ? n : Math.round((n * count) / 40);
      for (let k = 0; k < scaled && cursor < order.length; k++) scenarioById.set(order[cursor++]!, scenario);
    }

    ids.forEach((id, i) => {
      const scenario = opts.overrides?.[id] ?? scenarioById.get(id) ?? 'healthy';
      const rand = mulberry32(deriveSeed(seed, `conn:${id}`));
      const s: SimSession = {
        desc: { id, label: `Line ${pad(i + 1)}`, phone: `+999 0000 ${String(i + 1).padStart(4, '0')}` },
        scenario,
        rand,
        ackRand: mulberry32(deriveSeed(seed, `ack:${id}`)),
        conn: null,
        faultGeneration: null,
        faultAt: null,
        acksStopped: false,
        msgSeq: 0,
        lastGeneration: 1,
      };
      if (scenario !== 'healthy' && scenario !== 'silent_drop') {
        const delay =
          scenario === 'never_acked'
            ? between(rand, Math.round(window.min / 3), Math.round(window.max / 3))
            : between(rand, window.min, window.max);
        s.faultAt = this.clock.now() + delay;
        this.globalTimers.push(this.clock.setTimeout(() => this.triggerFault(s), delay));
      }
      this.sessions.set(id, s);
    });
  }

  // ---- public API ---------------------------------------------------------

  listSessions(): SessionDescriptor[] {
    return [...this.sessions.values()].map((s) => ({ ...s.desc }));
  }

  /** Simulator ground truth, exposed for the UI and tests only. */
  scenarioOf(sessionId: string): Scenario | undefined {
    return this.sessions.get(sessionId)?.scenario;
  }

  async connect(sessionId: string, credentials: Credentials): Promise<void> {
    const s = this.require(sessionId);
    this.teardown(s);
    s.lastGeneration = credentials.generation;
    const conn: Connection = { generation: credentials.generation, open: false, silent: false, timers: [] };
    s.conn = conn;
    const faulty = s.faultGeneration !== null && credentials.generation <= s.faultGeneration;
    const latency = between(s.rand, 300, 1_800);

    if (faulty && s.scenario === 'logged_out') {
      // Server rejects the linked device: no open, straight to 401.
      this.later(s, conn, latency, () => this.close(s, CLOSE_LOGGED_OUT, 'logged out'));
      return;
    }
    if (faulty && s.scenario === 'stuck_reconnecting') {
      // Handshake never completes. No open, no close, no error.
      return;
    }
    this.later(s, conn, latency, () => this.open(s, conn));
  }

  async disconnect(sessionId: string): Promise<void> {
    this.teardown(this.require(sessionId));
  }

  async sendMessage(sessionId: string, message: OutboundMessage): Promise<SendResult> {
    const s = this.require(sessionId);
    const conn = s.conn;
    if (!conn || !conn.open) return { accepted: false, error: 'not_connected' };
    const providerMessageId = `wamid.SIM.${sessionId}.${++s.msgSeq}`;
    if (conn.silent) {
      // Looks sent from the caller's side; it never leaves the box.
      return { accepted: true, providerMessageId };
    }
    const r = s.ackRand;
    const sentAfter = between(r, 100, 400);
    this.later(s, conn, sentAfter, () => this.emit('ack', { sessionId, id: providerMessageId, status: 'sent' }));
    if (s.acksStopped) return { accepted: true, providerMessageId };

    const failed = r() < 0.03;
    const deliveredAfter = sentAfter + between(r, 800, 5_000);
    if (failed) {
      this.later(s, conn, deliveredAfter, () =>
        this.emit('ack', {
          sessionId,
          id: providerMessageId,
          status: 'failed',
          errorCode: 131026,
          errorTitle: 'Message undeliverable',
        }),
      );
      return { accepted: true, providerMessageId };
    }
    const willRead = r() < 0.6;
    const readAfter = deliveredAfter + between(r, 3_000, 40_000);
    // Acks are not tied to the socket: they arrive even if we reconnect.
    this.globalLater(deliveredAfter, () => {
      if (!s.acksStopped) this.emit('ack', { sessionId, id: providerMessageId, status: 'delivered' });
    });
    if (willRead) {
      this.globalLater(readAfter, () => this.emit('ack', { sessionId, id: providerMessageId, status: 'read' }));
    }
    return { accepted: true, providerMessageId };
  }

  on<E extends ProviderEvent>(event: E, listener: Listener<E>): void {
    this.listeners[event].add(listener);
  }

  off<E extends ProviderEvent>(event: E, listener: Listener<E>): void {
    this.listeners[event].delete(listener);
  }

  shutdown(): void {
    for (const s of this.sessions.values()) this.teardown(s);
    for (const t of this.globalTimers) this.clock.clearTimeout(t);
    this.globalTimers.length = 0;
  }

  // ---- internals ----------------------------------------------------------

  private require(sessionId: string): SimSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    return s;
  }

  private emit<E extends ProviderEvent>(event: E, payload: ProviderEventMap[E]): void {
    for (const l of [...this.listeners[event]]) (l as Listener<E>)(payload);
  }

  private later(s: SimSession, conn: Connection, ms: number, fn: () => void): void {
    const h = this.clock.setTimeout(() => {
      if (s.conn === conn) fn();
    }, ms);
    conn.timers.push(h);
  }

  private globalLater(ms: number, fn: () => void): void {
    const h = this.clock.setTimeout(() => {
      const i = this.globalTimers.indexOf(h);
      if (i >= 0) this.globalTimers.splice(i, 1);
      fn();
    }, ms);
    this.globalTimers.push(h);
  }

  private teardown(s: SimSession): void {
    const conn = s.conn;
    if (!conn) return;
    for (const t of conn.timers) this.clock.clearTimeout(t);
    this.clock.clearInterval(conn.heartbeat);
    s.conn = null;
  }

  private open(s: SimSession, conn: Connection): void {
    conn.open = true;
    const id = s.desc.id;
    this.emit('open', { sessionId: id });
    conn.heartbeat = this.clock.setInterval(() => {
      if (s.conn === conn && conn.open && !conn.silent) this.emit('heartbeat', { sessionId: id });
    }, this.heartbeatIntervalMs);

    const faulty = s.faultGeneration !== null && conn.generation <= s.faultGeneration;
    if (faulty && s.scenario === 'credential_error_loop') {
      this.later(s, conn, between(s.rand, 300, 900), () => this.credentialFailure(s));
      return;
    }
    if (s.scenario === 'silent_drop') {
      this.later(s, conn, between(s.rand, 60_000, 200_000), () => {
        // Heartbeats stop, acks stop, and *no* close event is emitted.
        conn.silent = true;
      });
      return;
    }
    if (s.scenario === 'healthy' && s.rand() < 0.15) {
      this.later(s, conn, between(s.rand, 120_000, 480_000), () => this.close(s, 428, 'connection lost'));
    }
  }

  private close(s: SimSession, code: number, reason: string): void {
    this.teardown(s);
    this.emit('close', { sessionId: s.desc.id, code, reason });
  }

  private credentialFailure(s: SimSession): void {
    this.emit('error', {
      sessionId: s.desc.id,
      code: 'CREDENTIAL_DECRYPT_FAILED',
      message: 'bad MAC while decrypting session keys',
      kind: 'credential',
    });
    this.close(s, 500, 'credential error');
  }

  private triggerFault(s: SimSession): void {
    const conn = s.conn;
    const generation = conn?.generation ?? s.lastGeneration;
    switch (s.scenario) {
      case 'never_acked':
        s.acksStopped = true;
        return;
      case 'logged_out':
        s.faultGeneration = generation;
        if (conn) this.close(s, CLOSE_LOGGED_OUT, 'logged out');
        return;
      case 'credential_error_loop':
        s.faultGeneration = generation;
        if (conn?.open) this.credentialFailure(s);
        return;
      case 'stuck_reconnecting':
        s.faultGeneration = generation;
        if (conn) this.close(s, 503, 'stream errored, restart required');
        return;
      default:
        return;
    }
  }
}
