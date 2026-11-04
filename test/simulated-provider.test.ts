import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../src/clock.js';
import { SimulatedProvider, type Scenario } from '../src/provider/simulated.js';
import type { Credentials, ProviderEventMap } from '../src/provider/types.js';

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const creds = (sessionId: string, generation = 1): Credentials => ({
  sessionId,
  generation,
  fingerprint: `fp-${generation}`,
  createdAt: T0,
});

function record(provider: SimulatedProvider, clock: VirtualClock) {
  const log: string[] = [];
  const push = (e: keyof ProviderEventMap) => (p: Record<string, unknown>) =>
    log.push(`${clock.now() - T0}:${e}:${JSON.stringify(p)}`);
  provider.on('open', push('open'));
  provider.on('close', push('close'));
  provider.on('error', push('error'));
  provider.on('ack', push('ack'));
  provider.on('heartbeat', push('heartbeat'));
  return log;
}

function single(scenario: Scenario, seed = 7) {
  const clock = new VirtualClock(T0);
  const provider = new SimulatedProvider({
    clock,
    seed,
    sessionCount: 1,
    mix: { silent_drop: 0, logged_out: 0, credential_error_loop: 0, stuck_reconnecting: 0, never_acked: 0 },
    overrides: { s01: scenario },
    faultWindowMs: { min: 30_000, max: 30_000 },
  });
  const events: Array<{ t: number; e: string; p: any }> = [];
  for (const e of ['open', 'close', 'error', 'ack', 'heartbeat'] as const) {
    provider.on(e, (p: any) => events.push({ t: clock.now() - T0, e, p }));
  }
  return { clock, provider, events };
}

describe('SimulatedProvider', () => {
  it('creates 40 sessions by default with the default fault mix', () => {
    const provider = new SimulatedProvider({ clock: new VirtualClock(T0) });
    const sessions = provider.listSessions();
    expect(sessions).toHaveLength(40);
    const counts: Record<string, number> = {};
    for (const s of sessions) {
      const sc = provider.scenarioOf(s.id)!;
      counts[sc] = (counts[sc] ?? 0) + 1;
    }
    expect(counts).toEqual({
      healthy: 27,
      silent_drop: 4,
      logged_out: 2,
      credential_error_loop: 2,
      stuck_reconnecting: 2,
      never_acked: 3,
    });
    expect(sessions.every((s) => s.phone.startsWith('+999 '))).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const run = (seed: number) => {
      const clock = new VirtualClock(T0);
      const provider = new SimulatedProvider({ clock, seed });
      const log = record(provider, clock);
      for (const s of provider.listSessions()) void provider.connect(s.id, creds(s.id));
      clock.advance(5 * 60_000);
      return { log, assignment: provider.listSessions().map((s) => provider.scenarioOf(s.id)) };
    };
    const a = run(42);
    const b = run(42);
    const c = run(43);
    expect(a.log.length).toBeGreaterThan(100);
    expect(a.log).toEqual(b.log);
    expect(a.assignment).toEqual(b.assignment);
    expect(c.assignment).not.toEqual(a.assignment);
  });

  it('silent drop: heartbeats stop and no close event is emitted', async () => {
    const { clock, provider, events } = single('silent_drop');
    await provider.connect('s01', creds('s01'));
    clock.advance(10 * 60_000);
    const hb = events.filter((e) => e.e === 'heartbeat');
    expect(events.filter((e) => e.e === 'open')).toHaveLength(1);
    expect(events.filter((e) => e.e === 'close')).toHaveLength(0);
    const lastHb = hb[hb.length - 1]!.t;
    expect(lastHb).toBeLessThan(10 * 60_000 - 60_000);
    // A message is still "accepted" but nothing ever comes back.
    const res = await provider.sendMessage('s01', { id: 'm1', to: '+999 1', text: 'hi' });
    expect(res.accepted).toBe(true);
    clock.advance(10 * 60_000);
    expect(events.filter((e) => e.e === 'ack')).toHaveLength(0);
  });

  it('logged out: closes with 401 and keeps rejecting the same credentials until a new generation', async () => {
    const { clock, provider, events } = single('logged_out');
    await provider.connect('s01', creds('s01', 1));
    clock.advance(31_000);
    expect(events.filter((e) => e.e === 'close').map((e) => e.p.code)).toEqual([401]);
    await provider.connect('s01', creds('s01', 1));
    clock.advance(5_000);
    expect(events.filter((e) => e.e === 'close').map((e) => e.p.code)).toEqual([401, 401]);
    await provider.connect('s01', creds('s01', 2));
    clock.advance(5_000);
    expect(events.some((e) => e.e === 'open' && e.t >= 36_000)).toBe(true);
    expect(events.filter((e) => e.e === 'close')).toHaveLength(2);
  });

  it('credential-error loop: every connect opens, errors with a credential error, then closes', async () => {
    const { clock, provider, events } = single('credential_error_loop');
    await provider.connect('s01', creds('s01'));
    clock.advance(31_000);
    for (let i = 0; i < 3; i++) {
      await provider.connect('s01', creds('s01'));
      clock.advance(3_000);
    }
    const errors = events.filter((e) => e.e === 'error');
    expect(errors).toHaveLength(4);
    expect(errors.every((e) => e.p.kind === 'credential')).toBe(true);
    expect(events.filter((e) => e.e === 'close').every((e) => e.p.code === 500)).toBe(true);
  });

  it('stuck reconnecting: after the fault, connect never opens and never closes', async () => {
    const { clock, provider, events } = single('stuck_reconnecting');
    await provider.connect('s01', creds('s01'));
    clock.advance(31_000);
    expect(events.filter((e) => e.e === 'close').map((e) => e.p.code)).toEqual([503]);
    const before = events.length;
    await provider.connect('s01', creds('s01'));
    clock.advance(10 * 60_000);
    expect(events.slice(before)).toEqual([]);
  });

  it('never acked: messages are accepted and get a "sent" ack but never "delivered"', async () => {
    const { clock, provider, events } = single('never_acked');
    await provider.connect('s01', creds('s01'));
    clock.advance(11_000); // fault window / 3 = 10s
    const res = await provider.sendMessage('s01', { id: 'm1', to: '+999 1', text: 'hi' });
    expect(res.accepted).toBe(true);
    clock.advance(5 * 60_000);
    const acks = events.filter((e) => e.e === 'ack').map((e) => e.p.status);
    expect(acks).toEqual(['sent']);
    expect(events.filter((e) => e.e === 'heartbeat').length).toBeGreaterThan(50);
  });

  it('healthy: messages progress through sent and delivered acks', async () => {
    const { clock, provider, events } = single('healthy', 1);
    await provider.connect('s01', creds('s01'));
    clock.advance(3_000);
    for (let i = 0; i < 10; i++) await provider.sendMessage('s01', { id: `m${i}`, to: '+999 1', text: 'x' });
    clock.advance(60_000);
    const statuses = events.filter((e) => e.e === 'ack').map((e) => e.p.status);
    expect(statuses.filter((s) => s === 'sent')).toHaveLength(10);
    expect(statuses.filter((s) => s === 'delivered' || s === 'failed')).toHaveLength(10);
  });

  it('refuses to send while disconnected', async () => {
    const { provider } = single('healthy');
    expect(await provider.sendMessage('s01', { id: 'm1', to: '+999 1', text: 'x' })).toEqual({
      accepted: false,
      error: 'not_connected',
    });
  });
});
