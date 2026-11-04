import { afterAll, describe, expect, it } from 'vitest';
import { RedisStateStore } from '../src/store/redis-state-store.js';
import { initialRecord } from '../src/monitor/state-machine.js';
import type { StoredSession } from '../src/store/state-store.js';

// Runs when REDIS_URL is set (CI provides a Redis service). Without it the
// suite is reported as skipped, not silently passed.
const url = process.env.REDIS_URL;

describe.runIf(url)('RedisStateStore', () => {
  const store = url ? new RedisStateStore(url, `wsm-test-${process.pid}`) : null;
  afterAll(async () => {
    await store?.clear();
    await store?.close();
  });

  const row = (id: string, state: StoredSession['state']): StoredSession => ({
    ...initialRecord(id, 0),
    state,
    label: id,
    phone: '+999 0',
    credentialFingerprint: 'abc',
    credentialGeneration: 1,
    credentialWipes: 0,
    undelivered: 2,
    flaggedTotal: 3,
    updatedAt: 1,
  });

  it('round-trips sessions and overwrites by id', async () => {
    await store!.clear();
    await store!.put([row('s02', 'connected'), row('s01', 'stuck')]);
    await store!.put([row('s02', 'degraded')]);
    const all = await store!.all();
    expect(all.map((s) => [s.id, s.state])).toEqual([
      ['s01', 'stuck'],
      ['s02', 'degraded'],
    ]);
    expect(await store!.get('s01')).toMatchObject({ undelivered: 2, flaggedTotal: 3 });
    expect(await store!.get('nope')).toBeNull();
  });
});
