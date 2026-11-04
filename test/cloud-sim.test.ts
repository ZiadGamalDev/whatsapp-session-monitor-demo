import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerExtensions } from '../src/extensions.js';
import type { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/server/app.js';
import { WINDOW_MS, windowState } from '../src/cloud/window.js';
import { checkTemplate } from '../src/cloud/templates.js';
import { testRuntime } from './helpers.js';

const auth = { authorization: 'Bearer demo-token' };
let rt: Runtime;
let app: FastifyInstance;

async function boot(over: Parameters<typeof testRuntime>[0] = {}) {
  rt = await testRuntime({ virtualTimeMs: 0, syntheticTraffic: false, cloudInboundIntervalMs: 86_400_000, ...over });
  app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
  await app.ready();
  await rt.start();
}
afterEach(async () => {
  await app?.close();
  await rt?.stop();
});

const send = (payload: unknown) => app.inject({ method: 'POST', url: '/api/messages/send', headers: auth, payload: payload as object });
const text = (to: string, body = 'hello') => ({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
const template = (to: string, name: string, params: string[] = [], code = 'ar') => ({
  messaging_product: 'whatsapp',
  to,
  type: 'template',
  template: { name, language: { code }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] },
});
/** Advance simulated time and let the signed webhooks run through the real route. */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 500) {
    rt.virtualClock!.advance(Math.min(500, ms - t));
    await rt.flush();
  }
}
const thread = async (waId: string) =>
  (await app.inject({ method: 'GET', url: `/api/inbox/conversations/${waId}`, headers: auth })).json();
const conversations = async () => (await app.inject({ method: 'GET', url: '/api/inbox/conversations', headers: auth })).json();
const byWindow = async (pred: (w: { open: boolean; remainingMs: number }) => boolean) =>
  (await conversations()).conversations.filter((c: { window: { open: boolean; remainingMs: number } }) => pred(c.window));

describe('24-hour window', () => {
  it('is open for 24 h after the last customer message', () => {
    expect(windowState(null, 0)).toEqual({ open: false, expiresAt: null, remainingMs: 0 });
    expect(windowState(1_000, 1_000 + WINDOW_MS - 1).open).toBe(true);
    expect(windowState(1_000, 1_000 + WINDOW_MS).open).toBe(false);
  });
});

describe('templates', () => {
  it('rejects unknown names/languages (132001) and wrong parameter counts (132000)', () => {
    expect(checkTemplate({ name: 'nope', language: { code: 'ar' } })).toMatchObject({ ok: false, status: 404 });
    expect(checkTemplate({ name: 'order_update', language: { code: 'fr' } })).toMatchObject({ ok: false });
    const bad = checkTemplate({ name: 'order_update', language: { code: 'ar' } });
    expect(bad.ok === false && bad.body.error.code).toBe(132000);
    const ok = checkTemplate({
      name: 'order_update',
      language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: '#A1' }] }],
    });
    expect(ok.ok && ok.text).toBe('Update on your order #A1: it has shipped.');
  });
});

describe('simulated Cloud API number', () => {
  it('seeds fake contacts with open, closing-soon and closed windows', async () => {
    await boot();
    const all = (await conversations()).conversations;
    expect(all).toHaveLength(12);
    expect(all.every((c: { number: string }) => c.number.startsWith('+999 '))).toBe(true);
    expect((await byWindow((w) => w.open)).length).toBe(6);
    expect((await byWindow((w) => w.open && w.remainingMs < 30 * 60_000)).length).toBe(1);
    expect((await byWindow((w) => !w.open)).length).toBe(6);
  });

  it('text inside the window: 200 means "accepted", then sent -> delivered arrive by signed webhook', async () => {
    await boot();
    const res = await send(text('+999 7100 0001'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ messaging_product: 'whatsapp', contacts: [{ wa_id: '99971000001' }], simulated: true });
    const wamid = body.messages[0].id;
    expect(wamid).toMatch(/^wamid\.SIM\.CLOUD\./);
    let m = (await thread('99971000001')).messages.find((x: { wamid: string }) => x.wamid === wamid);
    expect(m.status).toBe('pending');
    await advance(10_000);
    m = (await thread('99971000001')).messages.find((x: { wamid: string }) => x.wamid === wamid);
    expect(['delivered', 'read']).toContain(m.status);
    expect(m.sentAt).not.toBeNull();
    expect(m.deliveredAt).not.toBeNull();
  });

  it('free-form text outside the window is stopped locally with a Meta-shaped 131047', async () => {
    await boot();
    const closed = (await byWindow((w) => !w.open)).find((c: { waId: string }) => c.waId === '99971000008');
    expect(closed).toBeTruthy();
    const res = await send(text('+999 7100 0008'));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: 131047, error_data: { messaging_product: 'whatsapp' } },
      source: 'local_guard',
      simulated: true,
    });
    expect(res.json().error.fbtrace_id).toMatch(/^SIMTRACE/);
  });

  it('a template outside the window is allowed', async () => {
    await boot();
    const res = await send(template('+999 7100 0008', 'order_update', ['#A1001']));
    expect(res.statusCode).toBe(200);
    await advance(10_000);
    const t = await thread('99971000008');
    const last = t.messages[t.messages.length - 1];
    expect(last).toMatchObject({ kind: 'template', templateName: 'order_update', body: 'تحديث طلبك #A1001: تم شحن الطلب.' });
    expect(['delivered', 'read']).toContain(last.status);
  });

  it('with the guard off it behaves like Meta: accepted, then failed 131047 by webhook', async () => {
    await boot({ cloudEnforceWindow: false });
    const res = await send(text('+999 7100 0008'));
    expect(res.statusCode).toBe(200);
    await advance(5_000);
    const last = (await thread('99971000008')).messages.at(-1);
    expect(last.status).toBe('failed');
    expect(last.error).toMatch(/^131047/);
  });

  it('maps contact behaviour to documented failure codes', async () => {
    await boot();
    // 07: not on WhatsApp (window closed, so use a template)
    await send(template('+999 7100 0007', 'order_update', ['#A2']));
    // 05: marketing templates withheld
    await send(template('+999 7100 0005', 'seasonal_offer'));
    await advance(10_000);
    expect((await thread('99971000007')).messages.at(-1)).toMatchObject({ status: 'failed', sentAt: null });
    expect((await thread('99971000007')).messages.at(-1).error).toMatch(/^131026/);
    expect((await thread('99971000005')).messages.at(-1).error).toMatch(/^131049/);
  });

  it('a phone that stays offline is flagged "sent but never delivered" after the ack timeout', async () => {
    await boot();
    const res = await send(text('+999 7100 0003')); // offline contact, window open
    expect(res.statusCode).toBe(200);
    await advance(70_000);
    const last = (await thread('99971000003')).messages.at(-1);
    expect(last.status).toBe('sent');
    expect(last.undelivered).toBe(true);
  });

  it('validates requests like the API: bad number, missing body, unknown type, bad template', async () => {
    await boot();
    expect((await send(text('not-a-number'))).json().error.code).toBe(100);
    expect((await send({ to: '+999 7100 0001', type: 'text', text: {} })).json().error.code).toBe(100);
    expect((await send({ to: '+999 7100 0001', type: 'sticker' })).json().error.code).toBe(131051);
    expect((await send(template('+999 7100 0001', 'missing'))).json().error.code).toBe(132001);
    const mismatch = await send(template('+999 7100 0001', 'appointment_reminder', ['only one']));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe(132000);
    expect((await app.inject({ method: 'POST', url: '/api/messages/send', payload: text('+999 7100 0001') })).statusCode).toBe(401);
  });

  it('a simulated customer reply arrives through the webhook and opens the window', async () => {
    await boot();
    const before = (await thread('99971000009')).window;
    expect(before.open).toBe(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sim/customer-reply',
      headers: auth,
      payload: { waId: '99971000009', text: 'مرحباً' },
    });
    expect(res.statusCode).toBe(202);
    const after = await thread('99971000009');
    expect(after.window.open).toBe(true);
    expect(after.window.remainingMs).toBe(WINDOW_MS);
    expect(after.messages.at(-1)).toMatchObject({ direction: 'in', body: 'مرحباً', seeded: false });
    expect((await send(text('+999 7100 0009'))).statusCode).toBe(200);
  });

  it('lists the approved template catalog', async () => {
    await boot();
    const res = (await app.inject({ method: 'GET', url: '/api/templates', headers: auth })).json();
    expect(res.data.map((t: { name: string }) => t.name)).toEqual(['order_update', 'appointment_reminder', 'seasonal_offer']);
  });

  it('pushes an `inbox` event on the SSE stream when a customer writes', async () => {
    await boot();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?token=demo-token`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (!text.includes('event: fleet')) text += dec.decode((await reader.read()).value);
    await app.inject({ method: 'POST', url: '/api/sim/customer-reply', headers: auth, payload: { waId: '99971000009', text: 'hi' } });
    while (!text.includes('event: inbox')) text += dec.decode((await reader.read()).value);
    expect(text).toContain('"waId":"99971000009"');
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
  });
});
