import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebhookSender } from '../src/alerts/webhook.js';
import { DEFAULT_DEMO_TOKEN, loadConfig, validateConfig } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';
import { safeEqual } from '../src/server/auth.js';
import { buildApp, clampLimit } from '../src/server/app.js';
import { testRuntime } from './helpers.js';

const auth = { authorization: 'Bearer demo-token' };

describe('safeEqual', () => {
  it('compares without short-circuiting on length', () => {
    expect(safeEqual('demo-token', 'demo-token')).toBe(true);
    expect(safeEqual('demo-token', 'demo-tokem')).toBe(false);
    expect(safeEqual('demo-token', 'demo')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('config validation', () => {
  it('binds to loopback by default; the well-known demo token is only used on loopback', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.demoToken).toBe(DEFAULT_DEMO_TOKEN);
    expect(validateConfig(c)).toEqual([]);
    // Exposed without a token: a random one is generated (and announced), never the default.
    const a = loadConfig({ HOST: '0.0.0.0' });
    const b = loadConfig({ HOST: '0.0.0.0' });
    expect(a.demoToken).not.toBe(DEFAULT_DEMO_TOKEN);
    expect(a.demoToken.length).toBeGreaterThanOrEqual(32);
    expect(a.demoToken).not.toBe(b.demoToken);
    expect(validateConfig(a)[0]).toMatch(/generated/);
    // Exposed with the default token set explicitly: refuse to start.
    expect(() => validateConfig(loadConfig({ HOST: '0.0.0.0', DEMO_TOKEN: DEFAULT_DEMO_TOKEN }))).toThrow(/Refusing/);
    expect(validateConfig(loadConfig({ HOST: '0.0.0.0', DEMO_TOKEN: 'a-long-random-value' }))).toEqual([]);
  });

  it('docker-compose publishes on loopback only and has no token fallback', () => {
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    expect(compose).toMatch(/"127\.0\.0\.1:3000:3000"/);
    expect(compose).not.toMatch(/-\s*"3000:3000"/);
    expect(compose).toMatch(/DEMO_TOKEN: \$\{DEMO_TOKEN:-\}/);
    expect(compose).not.toContain('demo-token');
  });

  it('rejects bad numbers and a real webhook URL signed with the public default secret', () => {
    expect(() => validateConfig(loadConfig({ PORT: 'abc' }))).toThrow(/PORT/);
    expect(() => validateConfig(loadConfig({ SESSION_COUNT: '-3' }))).toThrow(/SESSION_COUNT/);
    expect(() => validateConfig(loadConfig({ ALERT_WEBHOOK_URL: 'https://hooks.example.test/x' }))).toThrow(
      /ALERT_WEBHOOK_SECRET/,
    );
    expect(() => validateConfig(loadConfig({ ALERT_WEBHOOK_URL: 'file:///etc/passwd', ALERT_WEBHOOK_SECRET: 's' }))).toThrow(
      /http\(s\)/,
    );
    expect(() =>
      validateConfig(loadConfig({ ALERT_WEBHOOK_URL: 'https://hooks.example.test/x', ALERT_WEBHOOK_SECRET: 'long-secret' })),
    ).not.toThrow();
  });
});

describe('.env.example', () => {
  it('loads, validates and keeps the demo local', () => {
    const env = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
    const c = loadConfig(env);
    expect(validateConfig(c)).toEqual([]);
    expect(c.host).toBe('127.0.0.1');
    expect(c.telegramNotifierEnabled).toBe(false);
    expect(c.cloudApiAppSecret).toBeNull();
    // Setting only the URL from the example must fail until a real secret is chosen.
    expect(() => validateConfig(loadConfig({ ...env, ALERT_WEBHOOK_URL: 'https://hooks.example.test/x' }))).toThrow();
  });
});

describe('clampLimit', () => {
  it('never lets a negative or junk limit through (SQLite treats LIMIT -1 as unlimited)', () => {
    expect(clampLimit('-1')).toBe(100);
    expect(clampLimit('0')).toBe(100);
    expect(clampLimit('abc')).toBe(100);
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit('25')).toBe(25);
    expect(clampLimit('100000')).toBe(500);
    expect(clampLimit('2.9')).toBe(2);
  });
});

describe('webhook sender does not follow redirects', () => {
  it('treats 3xx as a non-retryable failure and asks fetch not to follow', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    ) as unknown as typeof fetch;
    const s = new WebhookSender({ url: 'http://receiver.invalid', secret: 'k', fetchImpl });
    expect(await s.deliver('alert-1', {})).toEqual({ ok: false, attempts: 1, lastError: 'redirect 302 not followed' });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('HTTP hardening', () => {
  let rt: Runtime;
  let app: FastifyInstance;
  let base: string;
  beforeAll(async () => {
    rt = await testRuntime({ rateLimitMessagesPerMin: 3, rateLimitRelinksPerMin: 2, maxStreams: 1 });
    app = await buildApp(rt);
    await rt.start();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    await rt.stop();
  });

  it('sends security headers, and no-store on the API', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('only accepts fake +999 recipients', async () => {
    for (const to of ['12345', 'not-a-number', '+999', '+999 abc 1234', '+999 1']) {
      const res = await app.inject({ method: 'POST', url: '/api/messages', headers: auth, payload: { sessionId: 's01', to, text: 'x' } });
      expect(res.statusCode, to).toBe(400);
    }
  });

  it('rate-limits message sends per client', async () => {
    const send = () =>
      app.inject({ method: 'POST', url: '/api/messages', headers: auth, payload: { sessionId: 's01', to: '+999 0000 0001', text: 'x' } });
    for (let i = 0; i < 3; i++) expect((await send()).statusCode).not.toBe(429);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rate-limits relinks per client', async () => {
    const relink = () => app.inject({ method: 'POST', url: '/api/sessions/s01/relink', headers: auth });
    expect((await relink()).statusCode).toBe(202);
    expect((await relink()).statusCode).toBe(202);
    expect((await relink()).statusCode).toBe(429);
  });

  it('a negative ?limit does not return the whole table', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/messages?limit=500', headers: auth })).json();
    expect(all.messages.length).toBeGreaterThan(100);
    const res = (await app.inject({ method: 'GET', url: '/api/messages?limit=-1', headers: auth })).json();
    expect(res.messages).toHaveLength(100);
  });

  it('SSE: first event is the fleet, and concurrent streams are capped', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?token=demo-token`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text.startsWith('event: fleet\ndata: {')).toBe(true);
    const second = await fetch(`${base}/api/stream?token=demo-token`);
    expect(second.status).toBe(503);
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
    // The slot is released when the client goes away.
    await vi.waitFor(async () => {
      const again = await fetch(`${base}/api/stream?token=demo-token`);
      expect(again.status).toBe(200);
      await again.body?.cancel();
    });
  });
});
