/**
 * Per-session state machine, written as a pure reducer so every transition
 * can be tested without timers or I/O. The `SessionMonitor` feeds it inputs
 * and executes the effects it returns.
 *
 * Source of truth: the age of the last heartbeat, not the last event.
 * A transport can say "open" for minutes after it stopped carrying traffic,
 * so `connected` is only reported while heartbeats are fresh.
 *
 * CREDENTIAL RULE (enforced here and tested in test/state-machine.test.ts):
 *   Automatic recovery (reconnect, backoff, heartbeat timeout, 401, credential
 *   errors, reaching the attempt cap) NEVER produces a `wipe_credentials`
 *   effect. Only the explicit user input `relink` does. A 401 or a run of
 *   credential errors parks the session (`logged_out` / `stuck`) with its
 *   credentials intact, so a human decides whether to relink.
 */

export type SessionState = 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'logged_out' | 'stuck';

export const SESSION_STATES: SessionState[] = [
  'connecting',
  'connected',
  'degraded',
  'reconnecting',
  'logged_out',
  'stuck',
];

export type StuckReason = 'reconnect_cap' | 'credential_error_loop';

export interface MonitorPolicy {
  /** Heartbeat older than this: `degraded`. */
  degradedAfterMs: number;
  /** Heartbeat older than this: treat as dead, force a reconnect. */
  deadAfterMs: number;
  /** A connection must stay healthy this long before attempts reset. */
  stableAfterMs: number;
  /** How long to wait for `open` after calling connect. */
  connectTimeoutMs: number;
  backoffBaseMs: number;
  backoffFactor: number;
  backoffMaxMs: number;
  /** Reconnect attempts before the session is parked as `stuck`. */
  maxAttempts: number;
  /** Fraction of the delay used as +/- jitter (0 disables). */
  backoffJitter: number;
}

export const DEFAULT_POLICY: MonitorPolicy = {
  degradedAfterMs: 15_000,
  deadAfterMs: 45_000,
  stableAfterMs: 30_000,
  connectTimeoutMs: 15_000,
  backoffBaseMs: 1_000,
  backoffFactor: 2,
  backoffMaxMs: 30_000,
  maxAttempts: 6,
  backoffJitter: 0.2,
};

export interface SessionRecord {
  id: string;
  state: SessionState;
  stateSince: number;
  /** Consecutive failed attempts since the last stable connection. */
  attempts: number;
  /** Total reconnects performed (never reset; shown in the fleet table). */
  reconnectCount: number;
  openedAt: number | null;
  lastHeartbeatAt: number | null;
  /** What a naive dashboard would show: the last raw provider event. */
  lastEvent: string | null;
  lastEventAt: number | null;
  lastCloseCode: number | null;
  lastError: string | null;
  lastErrorKind: 'credential' | 'transport' | 'other' | null;
  consecutiveCredentialErrors: number;
  stuckReason: StuckReason | null;
  /** Set by 401 / credential loop; cleared only by relink. */
  needsRelink: boolean;
  /** True while a connect call is outstanding and we wait for `open`. */
  awaitingOpen: boolean;
}

export type Input =
  | { type: 'start'; now: number }
  | { type: 'open'; now: number }
  | { type: 'heartbeat'; now: number }
  | { type: 'close'; now: number; code: number; reason?: string }
  | { type: 'error'; now: number; code: string; kind: 'credential' | 'transport' | 'other' }
  | { type: 'connect_timeout'; now: number }
  | { type: 'reconnect_due'; now: number }
  | { type: 'tick'; now: number }
  | { type: 'relink'; now: number };

export type Effect =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'arm_connect_timeout'; ms: number }
  | { type: 'clear_connect_timeout' }
  | { type: 'schedule_reconnect'; attempt: number; delayMs: number }
  | { type: 'cancel_reconnect' }
  | { type: 'wipe_credentials' };

export interface Result {
  record: SessionRecord;
  effects: Effect[];
  /** Short machine reason for the transition (shown in the timeline). */
  reason?: string;
}

export function initialRecord(id: string, now: number): SessionRecord {
  return {
    id,
    state: 'connecting',
    stateSince: now,
    attempts: 0,
    reconnectCount: 0,
    openedAt: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastEventAt: null,
    lastCloseCode: null,
    lastError: null,
    lastErrorKind: null,
    consecutiveCredentialErrors: 0,
    stuckReason: null,
    needsRelink: false,
    awaitingOpen: false,
  };
}

/** Exponential backoff with optional jitter. `rand` in [0,1), 0.5 = no jitter. */
export function backoffDelay(attempt: number, policy: MonitorPolicy, rand = 0.5): number {
  const raw = policy.backoffBaseMs * Math.pow(policy.backoffFactor, Math.max(0, attempt - 1));
  const capped = Math.min(policy.backoffMaxMs, raw);
  const jitter = capped * policy.backoffJitter * (rand * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export function heartbeatAge(r: SessionRecord, now: number): number | null {
  const ref = r.lastHeartbeatAt ?? r.openedAt;
  return ref === null ? null : Math.max(0, now - ref);
}

const PARKED: SessionState[] = ['logged_out', 'stuck'];

function setState(r: SessionRecord, state: SessionState, now: number): SessionRecord {
  return r.state === state ? r : { ...r, state, stateSince: now };
}

/**
 * Connection failed or was declared dead: either schedule another attempt
 * or park the session as `stuck` once the cap is reached. Never wipes
 * credentials.
 */
function failAndMaybeRetry(
  r: SessionRecord,
  now: number,
  policy: MonitorPolicy,
  rand: number,
  extra: Effect[],
  reason: string,
): Result {
  const attempts = r.attempts + 1;
  const base: SessionRecord = { ...r, attempts, awaitingOpen: false, openedAt: null };
  if (attempts > policy.maxAttempts) {
    const stuckReason: StuckReason =
      r.consecutiveCredentialErrors >= policy.maxAttempts ? 'credential_error_loop' : 'reconnect_cap';
    return {
      record: { ...setState(base, 'stuck', now), stuckReason, needsRelink: stuckReason === 'credential_error_loop' },
      effects: [...extra, { type: 'clear_connect_timeout' }],
      reason: stuckReason,
    };
  }
  return {
    record: setState(base, 'reconnecting', now),
    effects: [
      ...extra,
      { type: 'clear_connect_timeout' },
      { type: 'schedule_reconnect', attempt: attempts, delayMs: backoffDelay(attempts, policy, rand) },
    ],
    reason,
  };
}

/**
 * @param rand jitter source in [0,1); pass 0.5 for a deterministic delay.
 */
export function reduce(r: SessionRecord, input: Input, policy: MonitorPolicy = DEFAULT_POLICY, rand = 0.5): Result {
  const now = input.now;
  switch (input.type) {
    case 'start':
      return {
        record: { ...setState(r, 'connecting', now), awaitingOpen: true },
        effects: [{ type: 'connect' }, { type: 'arm_connect_timeout', ms: policy.connectTimeoutMs }],
        reason: 'start',
      };

    case 'relink':
      // The ONLY path that produces `wipe_credentials`.
      return {
        record: {
          ...setState(r, 'connecting', now),
          attempts: 0,
          awaitingOpen: true,
          openedAt: null,
          stuckReason: null,
          needsRelink: false,
          consecutiveCredentialErrors: 0,
          lastError: null,
          lastErrorKind: null,
        },
        effects: [
          { type: 'cancel_reconnect' },
          { type: 'clear_connect_timeout' },
          { type: 'disconnect' },
          { type: 'wipe_credentials' },
          { type: 'connect' },
          { type: 'arm_connect_timeout', ms: policy.connectTimeoutMs },
        ],
        reason: 'user_relink',
      };

    case 'open': {
      const rec = { ...r, lastEvent: 'open', lastEventAt: now };
      if (r.state === 'logged_out') return { record: rec, effects: [] };
      return {
        record: {
          ...setState(rec, 'connected', now),
          openedAt: now,
          lastHeartbeatAt: now,
          awaitingOpen: false,
          stuckReason: null,
        },
        effects: [{ type: 'clear_connect_timeout' }],
        reason: 'open',
      };
    }

    case 'heartbeat': {
      const rec = { ...r, lastHeartbeatAt: now };
      if (r.state === 'degraded') return { record: setState(rec, 'connected', now), effects: [], reason: 'heartbeat_resumed' };
      return { record: rec, effects: [] };
    }

    case 'error': {
      const credential = input.kind === 'credential';
      return {
        record: {
          ...r,
          lastEvent: 'error',
          lastEventAt: now,
          lastError: input.code,
          lastErrorKind: input.kind,
          consecutiveCredentialErrors: credential ? r.consecutiveCredentialErrors + 1 : 0,
        },
        effects: [],
      };
    }

    case 'close': {
      const rec = { ...r, lastEvent: 'close', lastEventAt: now, lastCloseCode: input.code };
      if (input.code === 401) {
        // Logged out: stop retrying (retrying a revoked device can get the
        // number flagged) but keep the credentials for forensics / relink.
        return {
          record: { ...setState(rec, 'logged_out', now), awaitingOpen: false, openedAt: null, needsRelink: true },
          effects: [{ type: 'clear_connect_timeout' }, { type: 'cancel_reconnect' }],
          reason: 'logged_out_401',
        };
      }
      if (PARKED.includes(r.state)) return { record: rec, effects: [] };
      if (r.state === 'reconnecting' && !r.awaitingOpen) return { record: rec, effects: [] };
      return failAndMaybeRetry(rec, now, policy, rand, [], `close_${input.code}`);
    }

    case 'connect_timeout': {
      if (!r.awaitingOpen || PARKED.includes(r.state)) return { record: r, effects: [] };
      return failAndMaybeRetry(r, now, policy, rand, [{ type: 'disconnect' }], 'connect_timeout');
    }

    case 'reconnect_due': {
      if (r.state !== 'reconnecting') return { record: r, effects: [] };
      return {
        record: { ...r, awaitingOpen: true, reconnectCount: r.reconnectCount + 1 },
        effects: [{ type: 'connect' }, { type: 'arm_connect_timeout', ms: policy.connectTimeoutMs }],
      };
    }

    case 'tick': {
      if (r.state !== 'connected' && r.state !== 'degraded') return { record: r, effects: [] };
      const age = heartbeatAge(r, now) ?? 0;
      if (age >= policy.deadAfterMs) {
        // Silent drop: the transport never told us. Tear it down ourselves.
        return failAndMaybeRetry(r, now, policy, rand, [{ type: 'disconnect' }], 'heartbeat_timeout');
      }
      if (age >= policy.degradedAfterMs) {
        return r.state === 'degraded'
          ? { record: r, effects: [] }
          : { record: setState(r, 'degraded', now), effects: [], reason: 'heartbeat_stale' };
      }
      if (r.attempts > 0 && r.openedAt !== null && now - r.openedAt >= policy.stableAfterMs) {
        return { record: { ...r, attempts: 0, consecutiveCredentialErrors: 0 }, effects: [] };
      }
      return { record: r, effects: [] };
    }
  }
}
