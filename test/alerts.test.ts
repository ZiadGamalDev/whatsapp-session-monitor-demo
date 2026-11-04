import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { AlertManager, alertTypeFor } from '../src/alerts/alerts.js';
import { TelegramNotifierStub } from '../src/alerts/telegram.js';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WebhookSender,
  signPayload,
  verifyPayload,
} from '../src/alerts/webhook.js';
import { SystemClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { registerExtensions } from '../src/extensions.js';
import type { SessionMonitor, Transition } from '../src/monitor/monitor.js';
import type { Runtime } from '../src/runtime.js';
import { MonitorDb } from '../src/store/db.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('webhook signing', () => {
  const body = JSON.stringify({ hello: 'world' });
  const now = 1_700_000_000_000;

  it('round-trips and rejects tampering, wrong secret and stale timestamps', () => {
    const ts = String(now);
    const sig = signPayload('s3cret', ts, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyPayload('s3cret', body, ts, sig, { now })).toBe(true);
    expect(verifyPayload('s3cret', body.replace('world', 'w0rld'), ts, sig, { now })).toBe(false);
    expect(verifyPayload('other', body, ts, sig, { now })).toBe(false);
    expect(verifyPayload('s3cret', body, ts, sig, { now: now + 10 * 60_000 })).toBe(false);
    expect(verifyPayload('s3cret', body, undefined, sig, { now })).toBe(false);
  });
});

describe('WebhookSender retries', () => {
  function sender(statuses: Array<number | 'throw'>) {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ headers: init!.headers as Record<string, string>, body: String(init!.body) });
      const next = statuses.shift() ?? 200;
      if (next === 'throw') throw new Error('ECONNREFUSED');
      return new Response('{}', { status: next });
    }) as unknown as typeof fetch;
    const s = new WebhookSender({ url: 'http://receiver.invalid/hook', secret: 'k', fetchImpl, maxAttempts: 5 });
    return { s, calls };
  }

  it('retries 5xx and network errors with exponential backoff, then succeeds', async () => {
    vi.useFakeTimers();
    const { s, calls } = sender([503, 'throw', 500, 200]);
    const infos: Array<{ attempt: number; nextDelayMs: number | null }> = [];
    const p = s.deliver('alert-1', { a: 1 }, (i) => infos.push({ attempt: i.attempt, nextDelayMs: i.nextDelayMs }));
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;
    expect(res).toEqual({ ok: true, attempts: 4, lastError: null });
    expect(infos.map((i) => i.nextDelayMs)).toEqual([500, 1_000, 2_000, null]);
    // Every attempt is signed over its own timestamp.
    for (const c of calls) {
      expect(verifyPayload('k', c.body, c.headers[TIMESTAMP_HEADER], c.headers[SIGNATURE_HEADER])).toBe(true);
    }
  });

  it('gives up after maxAttempts', async () => {
    vi.useFakeTimers();
    const { s, calls } = sender([500, 500, 500, 500, 500, 500]);
    const p = s.deliver('alert-2', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toEqual({ ok: false, attempts: 5, lastError: 'HTTP 500' });
    expect(calls).toHaveLength(5);
  });

  it('does not retry a 4xx rejection (except 429)', async () => {
    const { s, calls } = sender([400]);
    expect(await s.deliver('alert-3', {})).toEqual({ ok: false, attempts: 1, lastError: 'HTTP 400' });
    expect(calls).toHaveLength(1);
  });
});

describe('alert rules', () => {
  it('alerts on entering problem states and on recovery, not on start-up', () => {
    expect(alertTypeFor({ from: 'connecting', to: 'connected' })).toBeNull();
    expect(alertTypeFor({ from: 'connected', to: 'degraded' })).toBe('state_change');
    expect(alertTypeFor({ from: 'degraded', to: 'reconnecting' })).toBe('state_change');
    expect(alertTypeFor({ from: 'reconnecting', to: 'stuck' })).toBe('state_change');
    expect(alertTypeFor({ from: 'connected', to: 'logged_out' })).toBe('state_change');
    expect(alertTypeFor({ from: 'reconnecting', to: 'connected' })).toBe('recovered');
    expect(alertTypeFor({ from: 'logged_out', to: 'connecting' })).toBeNull();
  });
});

describe('AlertManager + Telegram stub', () => {
  function manager(opts: { telegram: boolean; webhook?: WebhookSender | null }) {
    const db = new MonitorDb(':memory:');
    const bus = new EventEmitter();
    const monitor = new EventEmitter() as unknown as SessionMonitor;
    (monitor as unknown as { snapshot: () => { label: string } }).snapshot = () => ({ label: 'Line 07' });
    const telegram = new TelegramNotifierStub(opts.telegram);
    const m = new AlertManager({ clock: new SystemClock(), db, bus, monitor, webhook: opts.webhook ?? null, telegram });
    m.start();
    return { db, bus, monitor, telegram };
  }
  const t = (from: Transition['from'], to: Transition['to'], reason: string): Transition => ({
    sessionId: 's07',
    from,
    to,
    reason,
    at: Date.UTC(2026, 0, 1, 9),
  });

  it('records alerts with no webhook as not_configured; telegram stub is off by default', () => {
    expect(loadConfig({}).telegramNotifierEnabled).toBe(false);
    const { db, monitor, telegram } = manager({ telegram: false });
    monitor.emit('transition', t('connecting', 'connected', 'open'));
    monitor.emit('transition', t('connected', 'logged_out', 'logged_out_401'));
    const rows = db.alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'state_change', toState: 'logged_out', deliveryStatus: 'not_configured' });
    expect(telegram.outbox).toEqual([]);
  });

  it('when enabled, the telegram stub only formats text (no network)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { telegram, monitor } = manager({ telegram: true });
    monitor.emit('transition', t('reconnecting', 'stuck', 'reconnect_cap'));
    expect(telegram.outbox).toEqual([
      '[ALERT] Line 07 (s07): reconnecting -> stuck (reconnect_cap) at 2026-01-01T09:00:00.000Z [simulated]',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('tracks webhook delivery status per alert', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const webhook = new WebhookSender({ url: 'http://receiver.invalid', secret: 'k', fetchImpl });
    const { db, monitor } = manager({ telegram: false, webhook });
    monitor.emit('transition', t('connected', 'degraded', 'heartbeat_stale'));
    await vi.waitFor(() => expect(db.alerts()[0]!.deliveryStatus).toBe('delivered'));
    expect(db.alerts()[0]).toMatchObject({ attempts: 1, channels: ['webhook'] });
  });
});

describe('demo alert sink', () => {
  it('verifies the signature on the raw body and simulates one outage per fourth alert', async () => {
    const app = Fastify();
    const config = { ...loadConfig({}), alertWebhookSecret: 'sink-secret', demoAlertSink: true };
    await registerExtensions(app, { config } as unknown as Runtime);
    const body = JSON.stringify({ id: 4, sessionId: 's01' });
    const ts = String(Date.now());
    const headers = (id: number, attempt: number, sig = signPayload('sink-secret', ts, body)) => ({
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: sig,
      [TIMESTAMP_HEADER]: ts,
      'x-monitor-delivery': `alert-${id}`,
      'x-monitor-attempt': String(attempt),
    });
    const post = (h: Record<string, string>) => app.inject({ method: 'POST', url: '/demo/alert-sink', headers: h, payload: body });
    expect((await post(headers(1, 1))).statusCode).toBe(200);
    expect((await post(headers(4, 1))).statusCode).toBe(503);
    expect((await post(headers(4, 2))).statusCode).toBe(200);
    expect((await post(headers(1, 1, 'sha256=' + '0'.repeat(64)))).statusCode).toBe(401);
    await app.close();
  });
});

describe('end to end: runtime alerts reach the signed sink', () => {
  it('delivers alerts produced by the simulated fleet', async () => {
    const { testRuntime } = await import('./helpers.js');
    const { buildApp } = await import('../src/server/app.js');
    const rt = await testRuntime({ virtualTimeMs: 4 * 60_000, demoAlertSink: true });
    const app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    rt.selfUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    await rt.start();
    await vi.waitFor(
      () => {
        const rows = rt.db.alerts({ limit: 500 });
        expect(rows.length).toBeGreaterThan(5);
        expect(rows.every((r) => r.deliveryStatus === 'delivered')).toBe(true);
      },
      { timeout: 10_000, interval: 100 },
    );
    const rows = rt.db.alerts({ limit: 500 });
    expect(rows.some((r) => r.attempts === 2)).toBe(true); // the simulated outage was retried
    expect(rows.some((r) => r.toState === 'logged_out')).toBe(true);
    await app.close();
    await rt.stop();
  });
});
