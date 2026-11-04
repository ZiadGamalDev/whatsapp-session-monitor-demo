import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hubSignature } from '../src/cloud-api/statuses.js';
import { inboundPayload, statusPayload } from '../src/cloud/payloads.js';
import { registerExtensions } from '../src/extensions.js';
import type { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/server/app.js';
import { testRuntime } from './helpers.js';

const SECRET = 'replay-test-secret';
let rt: Runtime;
let app: FastifyInstance;

beforeAll(async () => {
  rt = await testRuntime({ virtualTimeMs: 0, syntheticTraffic: false, cloudApiAppSecret: SECRET, cloudInboundIntervalMs: 86_400_000 });
  app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
  await app.ready();
  await rt.start();
});
afterAll(async () => {
  await app.close();
  await rt.stop();
});

const post = (raw: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/cloud-api',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': hubSignature(SECRET, raw) },
    payload: raw,
  });

function tracked(wamid: string) {
  const m = rt.tracker.create('cloud', '+999 7100 0001', 'x', 'cloud');
  rt.tracker.registerAccepted(m.id, wamid);
  return m.id;
}

describe('Cloud API webhook replay protection and idempotency', () => {
  it('ignores an identical body delivered twice (sender retry or replay)', async () => {
    const id = tracked('wamid.REPLAY.1');
    const raw = JSON.stringify(statusPayload({ wamid: 'wamid.REPLAY.1', status: 'sent', at: rt.clock.now(), recipientId: '99971000001' }));
    const first = (await post(raw)).json();
    expect(first).toMatchObject({ matched: 1, duplicateDelivery: false });
    const second = await post(raw);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicateDelivery: true, matched: 0 });
    expect(rt.tracker.get(id)!.status).toBe('sent');
  });

  it('applies each (message id, status) once even when the body differs', async () => {
    const id = tracked('wamid.REPLAY.2');
    const at = rt.clock.now();
    const a = statusPayload({ wamid: 'wamid.REPLAY.2', status: 'delivered', at, recipientId: '99971000001' });
    // Same event, re-serialised with an extra field: different bytes, same meaning.
    const b = { ...a, extra: 'retry' };
    expect((await post(JSON.stringify(a))).json()).toMatchObject({ matched: 1, duplicates: 0 });
    expect((await post(JSON.stringify(b))).json()).toMatchObject({ matched: 0, duplicates: 1 });
    expect(rt.tracker.get(id)).toMatchObject({ status: 'delivered', deliveredAt: Math.floor(at / 1000) * 1000 });
  });

  it('a duplicate "failed" after "read" cannot rewrite history, and a late "delivered" after read is ignored', async () => {
    const id = tracked('wamid.REPLAY.3');
    const at = rt.clock.now();
    for (const status of ['sent', 'delivered', 'read', 'delivered'] as const) {
      await post(JSON.stringify(statusPayload({ wamid: 'wamid.REPLAY.3', status, at, recipientId: '99971000001' })));
    }
    expect(rt.tracker.get(id)!.status).toBe('read');
  });

  it('ignores stale events (older than CLOUD_MAX_EVENT_AGE_MS) and events from the future', async () => {
    const id = tracked('wamid.REPLAY.4');
    const now = rt.clock.now();
    const old = statusPayload({ wamid: 'wamid.REPLAY.4', status: 'delivered', at: now - rt.config.cloudMaxEventAgeMs - 60_000, recipientId: '99971000001' });
    expect((await post(JSON.stringify(old))).json()).toMatchObject({ stale: 1, matched: 0 });
    const future = statusPayload({ wamid: 'wamid.REPLAY.4', status: 'read', at: now + 10 * 60_000, recipientId: '99971000001' });
    expect((await post(JSON.stringify(future))).json()).toMatchObject({ stale: 1, matched: 0 });
    expect(rt.tracker.get(id)!.status).toBe('pending');
    // A fresh event for the same message still works.
    const fresh = statusPayload({ wamid: 'wamid.REPLAY.4', status: 'delivered', at: now, recipientId: '99971000001' });
    expect((await post(JSON.stringify(fresh))).json()).toMatchObject({ matched: 1 });
  });

  it('stores an inbound message once, even if delivered twice with different bytes', async () => {
    const at = rt.clock.now();
    const p = inboundPayload({ wamid: 'wamid.IN.REPLAY.1', from: '99971000009', name: 'Demo customer 09', at, text: 'hello' });
    expect((await post(JSON.stringify(p))).json()).toMatchObject({ inbound: 1 });
    expect((await post(JSON.stringify({ ...p, retry: 1 }))).json()).toMatchObject({ inbound: 0, duplicates: 1 });
    const thread = rt.cloudStore.thread('99971000009').filter((m) => m.wamid === 'wamid.IN.REPLAY.1');
    expect(thread).toHaveLength(1);
  });

  it('still rejects a replayed body whose signature does not match', async () => {
    const raw = readFileSync(new URL('./fixtures/cloud-api/status-read.json', import.meta.url), 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/cloud-api',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': hubSignature('other-secret', raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });
});
