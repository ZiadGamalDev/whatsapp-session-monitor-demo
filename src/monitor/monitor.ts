import { EventEmitter } from 'node:events';
import type { Clock, TimerHandle } from '../clock.js';
import { deriveSeed, mulberry32 } from '../rng.js';
import type { ProviderEventMap, SessionDescriptor, SessionProvider } from '../provider/types.js';
import type { CredentialStore } from './credentials.js';
import {
  DEFAULT_POLICY,
  heartbeatAge,
  initialRecord,
  reduce,
  type Effect,
  type Input,
  type MonitorPolicy,
  type SessionRecord,
  type SessionState,
} from './state-machine.js';

export type TimelineKind = 'event' | 'transition' | 'action' | 'message';

export interface TimelineEntry {
  sessionId: string;
  at: number;
  kind: TimelineKind;
  /** Machine key, translated by the dashboard (e.g. `close`, `heartbeat_timeout`). */
  code: string;
  detail?: Record<string, unknown>;
}

export interface Transition {
  sessionId: string;
  from: SessionState;
  to: SessionState;
  reason: string;
  at: number;
}

export interface SessionSnapshot extends SessionRecord {
  label: string;
  phone: string;
  heartbeatAgeMs: number | null;
  credentialFingerprint: string | null;
  credentialGeneration: number | null;
  credentialWipes: number;
}

export interface MonitorOptions {
  provider: SessionProvider;
  clock: Clock;
  credentials: CredentialStore;
  policy?: Partial<MonitorPolicy>;
  tickMs?: number;
  seed?: number;
}

interface Timers {
  connectTimeout?: TimerHandle;
  reconnect?: TimerHandle;
}

/**
 * Drives one state machine per session. Emits:
 *  - `transition` (Transition) when a session changes state
 *  - `timeline`   (TimelineEntry) for provider events, transitions and actions
 *  - `change`     (sessionId) whenever a record changed (incl. heartbeats)
 */
export class SessionMonitor extends EventEmitter {
  readonly policy: MonitorPolicy;
  private readonly provider: SessionProvider;
  private readonly clock: Clock;
  private readonly credentials: CredentialStore;
  private readonly tickMs: number;
  private readonly rand: () => number;
  private readonly records = new Map<string, SessionRecord>();
  private readonly descriptors = new Map<string, SessionDescriptor>();
  private readonly timers = new Map<string, Timers>();
  private tickHandle?: TimerHandle;
  private readonly handlers: { [E in keyof ProviderEventMap]: (p: ProviderEventMap[E]) => void };

  constructor(opts: MonitorOptions) {
    super();
    this.provider = opts.provider;
    this.clock = opts.clock;
    this.credentials = opts.credentials;
    this.policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
    this.tickMs = opts.tickMs ?? 1_000;
    this.rand = mulberry32(deriveSeed(opts.seed ?? 42, 'monitor-jitter'));
    this.handlers = {
      open: (p) => this.onProvider(p.sessionId, { type: 'open', now: this.clock.now() }, 'open'),
      close: (p) =>
        this.onProvider(p.sessionId, { type: 'close', now: this.clock.now(), code: p.code, reason: p.reason }, 'close', {
          code: p.code,
          reason: p.reason,
        }),
      error: (p) =>
        this.onProvider(p.sessionId, { type: 'error', now: this.clock.now(), code: p.code, kind: p.kind }, 'error', {
          code: p.code,
          kind: p.kind,
          message: p.message,
        }),
      heartbeat: (p) => this.apply(p.sessionId, { type: 'heartbeat', now: this.clock.now() }),
      ack: () => undefined, // handled by the DeliveryTracker
    };
  }

  start(): void {
    for (const k of Object.keys(this.handlers) as (keyof ProviderEventMap)[]) {
      this.provider.on(k, this.handlers[k] as never);
    }
    const now = this.clock.now();
    for (const d of this.provider.listSessions()) {
      this.descriptors.set(d.id, d);
      this.records.set(d.id, initialRecord(d.id, now));
      this.timers.set(d.id, {});
      if (!this.credentials.get(d.id)) this.credentials.issue(d.id, now);
    }
    for (const id of this.records.keys()) this.apply(id, { type: 'start', now });
    this.tickHandle = this.clock.setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    this.clock.clearInterval(this.tickHandle);
    for (const t of this.timers.values()) {
      this.clock.clearTimeout(t.connectTimeout);
      this.clock.clearTimeout(t.reconnect);
    }
    for (const k of Object.keys(this.handlers) as (keyof ProviderEventMap)[]) {
      this.provider.off(k, this.handlers[k] as never);
    }
  }

  /** Explicit user action. The only way credentials get wiped. */
  relink(sessionId: string): SessionSnapshot {
    if (!this.records.has(sessionId)) throw new Error(`unknown session ${sessionId}`);
    const now = this.clock.now();
    this.timeline({ sessionId, at: now, kind: 'action', code: 'relink_requested' });
    this.apply(sessionId, { type: 'relink', now });
    return this.snapshot(sessionId)!;
  }

  has(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  record(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const r = this.records.get(sessionId);
    const d = this.descriptors.get(sessionId);
    if (!r || !d) return undefined;
    const c = this.credentials.get(sessionId);
    return {
      ...r,
      label: d.label,
      phone: d.phone,
      heartbeatAgeMs: r.state === 'connected' || r.state === 'degraded' ? heartbeatAge(r, this.clock.now()) : null,
      credentialFingerprint: c?.fingerprint ?? null,
      credentialGeneration: c?.generation ?? null,
      credentialWipes: this.credentials.wipeCount(sessionId),
    };
  }

  snapshots(): SessionSnapshot[] {
    return [...this.records.keys()].map((id) => this.snapshot(id)!);
  }

  /** Re-evaluates heartbeat ages for every session. Runs every `tickMs`. */
  tick(): void {
    const now = this.clock.now();
    for (const id of this.records.keys()) this.apply(id, { type: 'tick', now });
  }

  // ---- internals ----------------------------------------------------------

  private onProvider(sessionId: string, input: Input, code: string, detail?: Record<string, unknown>): void {
    if (!this.records.has(sessionId)) return;
    this.timeline({ sessionId, at: input.now, kind: 'event', code, detail });
    this.apply(sessionId, input);
  }

  private apply(sessionId: string, input: Input): void {
    const prev = this.records.get(sessionId);
    if (!prev) return;
    const res = reduce(prev, input, this.policy, this.rand());
    this.records.set(sessionId, res.record);
    if (prev.state !== res.record.state) {
      const t: Transition = {
        sessionId,
        from: prev.state,
        to: res.record.state,
        reason: res.reason ?? input.type,
        at: input.now,
      };
      this.timeline({
        sessionId,
        at: input.now,
        kind: 'transition',
        code: t.reason,
        detail: { from: t.from, to: t.to },
      });
      this.emit('transition', t);
    }
    for (const e of res.effects) this.run(sessionId, e);
    if (prev !== res.record) this.emit('change', sessionId);
  }

  private run(sessionId: string, effect: Effect): void {
    const timers = this.timers.get(sessionId)!;
    switch (effect.type) {
      case 'connect': {
        const creds = this.credentials.get(sessionId) ?? this.credentials.issue(sessionId, this.clock.now());
        this.provider.connect(sessionId, creds).catch((err: unknown) => {
          const now = this.clock.now();
          this.onProvider(sessionId, { type: 'error', now, code: 'CONNECT_THREW', kind: 'transport' }, 'error', {
            message: String(err),
          });
          this.apply(sessionId, { type: 'close', now, code: 0 });
        });
        return;
      }
      case 'disconnect':
        void this.provider.disconnect(sessionId);
        return;
      case 'arm_connect_timeout':
        this.clock.clearTimeout(timers.connectTimeout);
        timers.connectTimeout = this.clock.setTimeout(() => {
          timers.connectTimeout = undefined;
          this.apply(sessionId, { type: 'connect_timeout', now: this.clock.now() });
        }, effect.ms);
        return;
      case 'clear_connect_timeout':
        this.clock.clearTimeout(timers.connectTimeout);
        timers.connectTimeout = undefined;
        return;
      case 'schedule_reconnect':
        this.clock.clearTimeout(timers.reconnect);
        this.timeline({
          sessionId,
          at: this.clock.now(),
          kind: 'action',
          code: 'reconnect_scheduled',
          detail: { attempt: effect.attempt, delayMs: effect.delayMs, maxAttempts: this.policy.maxAttempts },
        });
        timers.reconnect = this.clock.setTimeout(() => {
          timers.reconnect = undefined;
          this.apply(sessionId, { type: 'reconnect_due', now: this.clock.now() });
        }, effect.delayMs);
        return;
      case 'cancel_reconnect':
        this.clock.clearTimeout(timers.reconnect);
        timers.reconnect = undefined;
        return;
      case 'wipe_credentials': {
        const old = this.credentials.get(sessionId);
        this.credentials.wipe(sessionId);
        const fresh = this.credentials.issue(sessionId, this.clock.now());
        this.timeline({
          sessionId,
          at: this.clock.now(),
          kind: 'action',
          code: 'credentials_replaced',
          detail: { from: old?.fingerprint ?? null, to: fresh.fingerprint },
        });
        return;
      }
    }
  }

  private timeline(entry: TimelineEntry): void {
    this.emit('timeline', entry);
  }
}
