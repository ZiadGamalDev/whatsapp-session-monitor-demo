import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng.js';
import {
  DEFAULT_POLICY,
  backoffDelay,
  initialRecord,
  reduce,
  type Effect,
  type Input,
  type SessionRecord,
} from '../src/monitor/state-machine.js';

const P = { ...DEFAULT_POLICY, backoffJitter: 0 };

function run(inputs: Input[], start: SessionRecord = initialRecord('s01', 0)) {
  let r = start;
  const effects: Effect[][] = [];
  for (const i of inputs) {
    const res = reduce(r, i, P);
    r = res.record;
    effects.push(res.effects);
  }
  return { r, effects, all: effects.flat() };
}

const connected = () => run([{ type: 'start', now: 0 }, { type: 'open', now: 1_000 }]).r;

describe('state machine', () => {
  it('start -> connecting, open -> connected', () => {
    const a = reduce(initialRecord('s01', 0), { type: 'start', now: 0 }, P);
    expect(a.record.state).toBe('connecting');
    expect(a.effects.map((e) => e.type)).toEqual(['connect', 'arm_connect_timeout']);
    const b = reduce(a.record, { type: 'open', now: 500 }, P);
    expect(b.record.state).toBe('connected');
    expect(b.record.lastHeartbeatAt).toBe(500);
  });

  it('uses heartbeat age, not the last event: "open" with stale heartbeat is degraded', () => {
    const r = connected();
    const t = reduce(r, { type: 'tick', now: 1_000 + P.degradedAfterMs }, P);
    expect(t.record.state).toBe('degraded');
    expect(t.record.lastEvent).toBe('open'); // a naive dashboard would still say connected
    const back = reduce(t.record, { type: 'heartbeat', now: 1_000 + P.degradedAfterMs + 10 }, P);
    expect(back.record.state).toBe('connected');
  });

  it('declares a silent drop dead after deadAfterMs and schedules a reconnect', () => {
    const r = connected();
    const t = reduce(r, { type: 'tick', now: 1_000 + P.deadAfterMs }, P);
    expect(t.record.state).toBe('reconnecting');
    expect(t.reason).toBe('heartbeat_timeout');
    expect(t.effects).toContainEqual({ type: 'disconnect' });
    expect(t.effects).toContainEqual({ type: 'schedule_reconnect', attempt: 1, delayMs: 1_000 });
  });

  it('backs off exponentially up to the max delay', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(a, P))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    const jittered = { ...P, backoffJitter: 0.2 };
    expect(backoffDelay(3, jittered, 0)).toBe(3_200);
    expect(backoffDelay(3, jittered, 0.999999)).toBe(4_800);
  });

  it('parks the session as stuck once the attempt cap is reached', () => {
    let r = connected();
    let now = 2_000;
    const delays: number[] = [];
    r = reduce(r, { type: 'close', now, code: 428 }, P).record;
    for (let i = 0; i < P.maxAttempts; i++) {
      now += 60_000;
      r = reduce(r, { type: 'reconnect_due', now }, P).record;
      now += P.connectTimeoutMs;
      const res = reduce(r, { type: 'connect_timeout', now }, P);
      r = res.record;
      const s = res.effects.find((e) => e.type === 'schedule_reconnect');
      if (s && s.type === 'schedule_reconnect') delays.push(s.delayMs);
    }
    expect(r.state).toBe('stuck');
    expect(r.stuckReason).toBe('reconnect_cap');
    expect(r.reconnectCount).toBe(P.maxAttempts);
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    // Parked: ticks, late closes and timeouts do nothing.
    expect(reduce(r, { type: 'tick', now: now + 1e6 }, P).effects).toEqual([]);
    expect(reduce(r, { type: 'close', now, code: 500 }, P).effects).toEqual([]);
  });

  it('401 -> logged_out without retrying, credentials kept', () => {
    const res = reduce(connected(), { type: 'close', now: 5_000, code: 401 }, P);
    expect(res.record.state).toBe('logged_out');
    expect(res.record.needsRelink).toBe(true);
    expect(res.effects.map((e) => e.type)).toEqual(['clear_connect_timeout', 'cancel_reconnect']);
    expect(reduce(res.record, { type: 'tick', now: 1e9 }, P).effects).toEqual([]);
  });

  it('a credential-error loop ends in stuck(credential_error_loop), not a wipe', () => {
    let r = connected();
    let now = 2_000;
    const effects: Effect[] = [];
    for (let i = 0; i <= P.maxAttempts; i++) {
      for (const input of [
        { type: 'error', now, code: 'CREDENTIAL_DECRYPT_FAILED', kind: 'credential' },
        { type: 'close', now: now + 1, code: 500 },
        { type: 'reconnect_due', now: now + 40_000 },
        { type: 'open', now: now + 41_000 },
      ] as Input[]) {
        const res = reduce(r, input, P);
        r = res.record;
        effects.push(...res.effects);
      }
      now += 60_000;
    }
    expect(r.state === 'stuck' || r.state === 'connected').toBe(true);
    const parked = run(
      [
        { type: 'error', now, code: 'CREDENTIAL_DECRYPT_FAILED', kind: 'credential' },
        { type: 'close', now: now + 1, code: 500 },
      ],
      r,
    ).r;
    expect(parked.state).toBe('stuck');
    expect(parked.stuckReason).toBe('credential_error_loop');
    expect(parked.needsRelink).toBe(true);
    expect(effects.some((e) => e.type === 'wipe_credentials')).toBe(false);
  });

  it('resets attempts only after the connection has been stable', () => {
    let r = reduce(connected(), { type: 'close', now: 2_000, code: 428 }, P).record;
    r = reduce(r, { type: 'reconnect_due', now: 3_000 }, P).record;
    r = reduce(r, { type: 'open', now: 3_500 }, P).record;
    expect(r.attempts).toBe(1);
    r = reduce(r, { type: 'heartbeat', now: 3_500 + P.stableAfterMs - 1_000 }, P).record;
    r = reduce(r, { type: 'tick', now: 3_500 + P.stableAfterMs }, P).record;
    expect(r.attempts).toBe(0);
  });

  describe('credential rule: automatic recovery never wipes credentials', () => {
    const automatic: Array<(now: number, rnd: () => number) => Input> = [
      (now) => ({ type: 'start', now }),
      (now) => ({ type: 'open', now }),
      (now) => ({ type: 'heartbeat', now }),
      (now, rnd) => ({ type: 'close', now, code: [401, 428, 500, 503, 0][Math.floor(rnd() * 5)]! }),
      (now, rnd) => ({
        type: 'error',
        now,
        code: 'X',
        kind: (['credential', 'transport', 'other'] as const)[Math.floor(rnd() * 3)]!,
      }),
      (now) => ({ type: 'connect_timeout', now }),
      (now) => ({ type: 'reconnect_due', now }),
      (now) => ({ type: 'tick', now }),
    ];

    it('holds for 2,000 random sequences of every non-relink input', () => {
      const rnd = mulberry32(1234);
      for (let seq = 0; seq < 2_000; seq++) {
        let r = initialRecord('s01', 0);
        let now = 0;
        for (let step = 0; step < 60; step++) {
          now += Math.floor(rnd() * 70_000);
          const input = automatic[Math.floor(rnd() * automatic.length)]!(now, rnd);
          const res = reduce(r, input, DEFAULT_POLICY, rnd());
          expect(res.effects.find((e) => e.type === 'wipe_credentials')).toBeUndefined();
          r = res.record;
        }
      }
    });

    it('only an explicit relink wipes, from any state', () => {
      for (const state of ['connecting', 'connected', 'degraded', 'reconnecting', 'logged_out', 'stuck'] as const) {
        const res = reduce({ ...initialRecord('s01', 0), state }, { type: 'relink', now: 1 }, P);
        expect(res.effects.filter((e) => e.type === 'wipe_credentials')).toHaveLength(1);
        expect(res.record.state).toBe('connecting');
        expect(res.record.needsRelink).toBe(false);
      }
    });
  });
});
