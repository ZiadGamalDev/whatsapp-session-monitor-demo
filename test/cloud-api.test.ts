import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hubSignature, parseInboundWebhook, parseStatusWebhook, verifyHubSignature } from '../src/cloud-api/statuses.js';
import { registerExtensions } from '../src/extensions.js';
import type { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/server/app.js';
import { testRuntime } from './helpers.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cloud-api/${name}.json`, import.meta.url), 'utf8');
const SECRET = 'fixture-app-secret';

describe('parseStatusWebhook', () => {
  it('parses sent / delivered / read', () => {
    for (const status of ['sent', 'delivered', 'read'] as const) {
      const res = parseStatusWebhook(JSON.parse(fixture(`status-${status}`)));
      expect(res.skipped).toBe(0);
      expect(res.statuses).toHaveLength(1);
      expect(res.statuses[0]).toMatchObject({
        id: 'wamid.SIM.FIXTURE.1',
        status,
        recipientId: '99970000001',
        phoneNumberId: '100000000000001',
        errors: [],
      });
    }
    expect(parseStatusWebhook(JSON.parse(fixture('status-sent'))).statuses[0]!.at).toBe(1767258000_000);
  });

  it('parses failed with its error details', () => {
    const [s] = parseStatusWebhook(JSON.parse(fixture('status-failed'))).statuses;
    expect(s).toMatchObject({ id: 'wamid.SIM.FIXTURE.2', status: 'failed' });
    expect(s!.errors[0]).toMatchObject({ code: 131049 });
    expect(s!.errors[0]!.details).toContain('healthy ecosystem');
  });

  it('skips unknown statuses and non-message fields, and ignores foreign objects', () => {
    const res = parseStatusWebhook(JSON.parse(fixture('status-batch-mixed')));
    expect(res.statuses.map((s) => s.id)).toEqual(['wamid.SIM.FIXTURE.3', 'wamid.SIM.FIXTURE.4', 'wamid.SIM.UNKNOWN.9']);
    expect(res.skipped).toBe(1);
    expect(parseStatusWebhook({ object: 'page', entry: [] }).statuses).toEqual([]);
    expect(parseStatusWebhook(null).statuses).toEqual([]);
  });
});

describe('parseInboundWebhook', () => {
  it('parses inbound text and non-text messages with the contact name', () => {
    const res = parseInboundWebhook(JSON.parse(fixture('inbound-text')));
    expect(res.skipped).toBe(0);
    expect(res.messages).toHaveLength(3);
    expect(res.messages[0]).toMatchObject({ wamid: 'wamid.SIM.FIXTURE.IN.1', from: '99971000009', name: 'Demo customer 09', type: 'text', text: 'Hello, any update?', at: 1767258000_000 });
    expect(res.messages[2]).toMatchObject({ type: 'image', text: null });
    expect(parseInboundWebhook(JSON.parse(fixture('status-sent'))).messages).toEqual([]);
  });
});

describe('X-Hub-Signature-256', () => {
  it('verifies HMAC-SHA256 of the raw body with the app secret', () => {
    const raw = fixture('status-delivered');
    const sig = hubSignature(SECRET, raw);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyHubSignature(SECRET, raw, sig)).toBe(true);
    // Re-serialising the JSON changes the bytes: must be checked on the raw body.
    expect(verifyHubSignature(SECRET, JSON.stringify(JSON.parse(raw)), sig)).toBe(false);
    expect(verifyHubSignature('wrong', raw, sig)).toBe(false);
    expect(verifyHubSignature(SECRET, raw, sig.slice(7))).toBe(false);
    expect(verifyHubSignature(SECRET, raw, undefined)).toBe(false);
  });
});

describe('POST /webhooks/cloud-api', () => {
  let rt: Runtime;
  let app: FastifyInstance;
  beforeAll(async () => {
    rt = await testRuntime({
      virtualTimeMs: 10_000,
      syntheticTraffic: false,
      cloudApiAppSecret: SECRET,
      cloudApiVerifyToken: 'verify-me',
    });
    app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
    await rt.start();
  });
  afterAll(async () => {
    await app.close();
    await rt.stop();
  });

  const post = (raw: string, sig: string | null = hubSignature(SECRET, raw)) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/cloud-api',
      headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) },
      payload: raw,
    });

  const track = (providerId: string) => {
    const m = rt.tracker.create('s01', '+999 7000 0001', 'fixture');
    return rt.tracker.markAccepted(m.id, providerId);
  };

  it('answers the hub verification handshake', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/webhooks/cloud-api?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    const bad = await app.inject({
      method: 'GET',
      url: '/webhooks/cloud-api?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects missing or invalid signatures without touching the tracker', async () => {
    const m = track('wamid.SIM.FIXTURE.1');
    expect((await post(fixture('status-delivered'), null)).statusCode).toBe(401);
    expect((await post(fixture('status-delivered'), hubSignature('other', fixture('status-delivered')))).statusCode).toBe(401);
    expect(rt.tracker.get(m.id)!.status).toBe('sent');
  });

  it('moves a tracked message through delivered and read', async () => {
    const m = rt.tracker.findByProviderId('wamid.SIM.FIXTURE.1') ?? track('wamid.SIM.FIXTURE.1');
    const d = await post(fixture('status-delivered'));
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ received: 1, matched: 1, unmatched: 0, skipped: 0, duplicates: 0, stale: 0 });
    expect(rt.tracker.get(m.id)).toMatchObject({ status: 'delivered', deliveredAt: 1767258004_000 });
    await post(fixture('status-read'));
    expect(rt.tracker.get(m.id)).toMatchObject({ status: 'read', readAt: 1767258030_000 });
    // A late "sent" receipt does not move it backwards.
    await post(fixture('status-sent'));
    expect(rt.tracker.get(m.id)!.status).toBe('read');
  });

  it('records failures with the documented error code', async () => {
    const m = track('wamid.SIM.FIXTURE.2');
    await post(fixture('status-failed'));
    expect(rt.tracker.get(m.id)).toMatchObject({ status: 'failed' });
    expect(rt.tracker.get(m.id)!.error).toContain('131049');
  });

  it('counts unknown ids and skipped entries but still returns 200', async () => {
    track('wamid.SIM.FIXTURE.3');
    track('wamid.SIM.FIXTURE.4');
    const res = await post(fixture('status-batch-mixed'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 3, matched: 2, unmatched: 1, skipped: 1 });
  });

  it('clears an ack-timeout flag when the receipt finally arrives', async () => {
    const m = track('wamid.SIM.LATE.1');
    rt.virtualClock!.advance(rt.tracker.ackTimeoutMs + 1);
    expect(rt.tracker.get(m.id)!.undelivered).toBe(true);
    const raw = fixture('status-delivered').replace('wamid.SIM.FIXTURE.1', 'wamid.SIM.LATE.1');
    await post(raw);
    expect(rt.tracker.get(m.id)).toMatchObject({ status: 'delivered', undelivered: false, lateDelivery: true });
  });

  it('drops inbound senders outside the +999 demo range without storing anything', async () => {
    const res = await post(fixture('inbound-text'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inbound: 2, dropped: 1 });
    expect(rt.cloudStore.contact('12345')).toBeNull();
    const bodies = rt.cloudStore.thread('99971000009').map((m) => m.body);
    expect(bodies).toContain('Hello, any update?');
    expect(bodies).toContain('[image]');
    expect(bodies).not.toContain('should be dropped');
  });

  it('is disabled (503) when no app secret is configured and the simulator is off', async () => {
    const rt2 = await testRuntime({ virtualTimeMs: 0, syntheticTraffic: false, cloudSim: false });
    const app2 = await buildApp(rt2, { register: (a) => registerExtensions(a, rt2) });
    const raw = fixture('status-sent');
    const res = await app2.inject({
      method: 'POST',
      url: '/webhooks/cloud-api',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': hubSignature('x', raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(503);
    await app2.close();
    await rt2.stop();
  });
});

describe('rate limiting and payload limits on /webhooks/cloud-api', () => {
  let rt: Runtime;
  let app: FastifyInstance;

  beforeEach(async () => {
    rt = await testRuntime({
      virtualTimeMs: 10_000,
      syntheticTraffic: false,
      cloudApiAppSecret: SECRET,
      cloudApiVerifyToken: 'verify-me',
    });
    app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
    await rt.start();
  });

  afterEach(async () => {
    await app.close();
    await rt.stop();
  });

  it('rejects oversized POST with 413', async () => {
    const raw = fixture('status-delivered');
    const sig = hubSignature(SECRET, raw);
    // 64 KiB = 65,536 bytes. A 65,537+ byte payload should trigger 413.
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/cloud-api',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      payload: oversized,
    });
    expect(res.statusCode).toBe(413);
  });

  it('reaches 429 and returns retry-after on public GET after 30 requests and never bypasses', async () => {
    for (let i = 0; i < 30; i++) {
      const ok = await app.inject({
        method: 'GET',
        url: '/webhooks/cloud-api?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'GET',
      url: '/webhooks/cloud-api?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ error: 'rate_limited', retryAfter: expect.any(Number) });

    // GET must never bypass even if bypass headers are passed
    const bypassAttempt = await app.inject({
      method: 'GET',
      url: '/webhooks/cloud-api?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
      headers: { 'x-simulator-bypass': 'any-token' },
    });
    expect(bypassAttempt.statusCode).toBe(429);
  });

  it('reaches 429 and returns retry-after on public POST after 120 requests with independent bucket from GET', async () => {
    const raw = fixture('status-delivered');
    const sig = hubSignature(SECRET, raw);

    // Exhaust GET bucket first (30 requests) to prove buckets are independent
    for (let i = 0; i < 30; i++) {
      const getRes = await app.inject({
        method: 'GET',
        url: '/webhooks/cloud-api?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
      });
      expect(getRes.statusCode).toBe(200);
    }
    const getLimited = await app.inject({
      method: 'GET',
      url: '/webhooks/cloud-api?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
    });
    expect(getLimited.statusCode).toBe(429);

    // POST bucket is independent and still allows 120 requests
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/cloud-api',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/webhooks/cloud-api',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      payload: raw,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ error: 'rate_limited', retryAfter: expect.any(Number) });
  });

  it('rejects guessed bypass headers and arbitrary headers even with valid HMAC', async () => {
    const raw = fixture('status-delivered');
    const sig = hubSignature(SECRET, raw);

    // Arrange exhausted POST bucket (120 requests)
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/cloud-api',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
    }

    const guesses = [
      { 'x-simulator-bypass': 'wrong-secret' },
      { 'x-simulator-bypass': 'true' },
      { 'x-internal-bypass': 'true' },
      { 'x-bypass-token': 'secret' },
    ];

    for (const headers of guesses) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/cloud-api',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, ...headers },
        payload: raw,
      });
      expect(res.statusCode).toBe(429);
    }
  });

  it('keeps simulator internal deliveries functional even after external POST bucket is exhausted', async () => {
    const raw = fixture('status-delivered');
    const sig = hubSignature(SECRET, raw);

    // Arrange exhausted POST bucket (120 requests)
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/cloud-api',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
    }

    // Confirm external POST is rate-limited
    const external = await app.inject({
      method: 'POST',
      url: '/webhooks/cloud-api',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      payload: raw,
    });
    expect(external.statusCode).toBe(429);

    // Simulator internal delivery uses the closure-held bypass header and succeeds
    const contactWaId = '99971000001';
    const beforeCount = rt.cloudStore.thread(contactWaId).length;
    const wamid = rt.cloud!.customerReply(contactWaId, 'delivery bypass test');
    expect(wamid).toMatch(/^wamid\.SIM\.IN\./);

    await rt.cloud!.settle();

    const thread = rt.cloudStore.thread(contactWaId);
    expect(thread.length).toBe(beforeCount + 1);
    expect(thread[thread.length - 1]!.body).toBe('delivery bypass test');
  });
});
