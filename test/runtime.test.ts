import { describe, expect, it } from 'vitest';
import { testRuntime } from './helpers.js';

async function snapshot(seed: number) {
  const rt = await testRuntime({ seed, virtualTimeMs: 5 * 60_000 });
  await rt.start();
  const fleet = await rt.fleet();
  const out = {
    summary: fleet.summary,
    rows: fleet.sessions.map((s) => [s.id, s.state, s.reconnectCount, s.undelivered, s.heartbeatAgeMs]),
    totals: rt.tracker.totals(),
  };
  await rt.stop();
  return out;
}

describe('demo runtime', () => {
  it('replays the same fleet for the same seed (screenshots depend on this)', async () => {
    const a = await snapshot(42);
    const b = await snapshot(42);
    expect(a).toEqual(b);
    expect(a.summary.total).toBe(40);
    expect(a.totals.total).toBeGreaterThan(100);
  });

  it('a different seed gives a different fleet', async () => {
    const a = await snapshot(42);
    const c = await snapshot(7);
    expect(c.rows).not.toEqual(a.rows);
  });
});
