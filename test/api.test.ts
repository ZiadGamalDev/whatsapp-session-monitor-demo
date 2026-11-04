import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/server/app.js';
import { testRuntime } from './helpers.js';

let rt: Runtime;
let app: FastifyInstance;
const auth = { authorization: 'Bearer demo-token' };

beforeAll(async () => {
  rt = await testRuntime();
  app = await buildApp(rt);
  await rt.start();
});
afterAll(async () => {
  await app.close();
  await rt.stop();
});

describe('HTTP API', () => {
  it('GET /api/health is public and says it is simulated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', simulated: true, provider: 'simulated', sessions: 40 });
  });

  it('rejects missing or wrong tokens', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: '/api/sessions', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    // Query token only works for the SSE stream.
    expect((await app.inject({ method: 'GET', url: '/api/sessions?token=demo-token' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/stream' })).statusCode).toBe(401);
  });

  it('GET /api/sessions lists the fleet with a summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions).toHaveLength(40);
    expect(body.summary.total).toBe(40);
    const s = body.sessions[0];
    for (const k of ['id', 'state', 'heartbeatAgeMs', 'reconnectCount', 'undelivered', 'naiveStatus']) {
      expect(s).toHaveProperty(k);
    }
    // After six simulated minutes the scripted faults have fired.
    expect(body.summary.byState.logged_out).toBe(2);
    expect(body.summary.undelivered).toBeGreaterThan(0);
  });

  it('filters by state and by problems', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions?state=logged_out', headers: auth });
    const body = res.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.every((s: { state: string }) => s.state === 'logged_out')).toBe(true);
    const problems = (await app.inject({ method: 'GET', url: '/api/sessions?problems=1', headers: auth })).json();
    expect(problems.sessions.length).toBeGreaterThanOrEqual(2);
    expect(problems.sessions.length).toBeLessThan(40);
  });

  it('GET /api/sessions/:id returns detail with a timeline', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/sessions?state=logged_out', headers: auth })).json();
    const id = list.sessions[0].id;
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.id).toBe(id);
    expect(body.simulatorScenario).toBe('logged_out');
    expect(body.timeline.map((e: { code: string }) => e.code)).toContain('logged_out_401');
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope', headers: auth })).statusCode).toBe(404);
  });

  it('POST /api/sessions/:id/relink replaces credentials and reconnects', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/sessions?state=logged_out', headers: auth })).json();
    const before = list.sessions[0];
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${before.id}/relink`, headers: auth });
    expect(res.statusCode).toBe(202);
    const after = res.json().session;
    expect(after.state).toBe('connecting');
    expect(after.credentialGeneration).toBe(before.credentialGeneration + 1);
    expect(after.credentialWipes).toBe(1);
    rt.virtualClock!.advance(5_000);
    await rt.flush();
    const detail = (await app.inject({ method: 'GET', url: `/api/sessions/${before.id}`, headers: auth })).json();
    expect(detail.session.state).toBe('connected');
    expect(detail.timeline.map((e: { code: string }) => e.code)).toContain('credentials_replaced');
  });

  it('POST /api/messages validates input and tracks one message', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/messages', headers: auth, payload: { to: 'x' } });
    expect(bad.statusCode).toBe(400);
    const bulk = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: auth,
      payload: { sessionId: 's01', to: ['+999 0000 0001', '+999 0000 0002'], text: 'x' },
    });
    expect(bulk.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: auth,
      payload: { sessionId: 'zz', to: '+999 0000 0001', text: 'x' },
    });
    expect(unknown.statusCode).toBe(404);

    const fleet = (await app.inject({ method: 'GET', url: '/api/sessions?state=connected', headers: auth })).json();
    const sessionId = fleet.sessions[0].id;
    const ok = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: auth,
      payload: { sessionId, to: '+999 0000 0000', text: 'hello' },
    });
    expect(ok.statusCode).toBe(202);
    const m = ok.json().message;
    expect(m).toMatchObject({ sessionId, status: 'sent', source: 'api' });
    const list = (await app.inject({ method: 'GET', url: `/api/messages?sessionId=${sessionId}`, headers: auth })).json();
    expect(list.messages.some((x: { id: string }) => x.id === m.id)).toBe(true);
  });

  it('GET /api/messages?undelivered=1 returns only flagged messages', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/messages?undelivered=1', headers: auth })).json();
    expect(res.messages.length).toBeGreaterThan(0);
    expect(res.messages.every((m: { undelivered: boolean }) => m.undelivered)).toBe(true);
  });

  it('GET /api/messages: totals come from the same store as the list', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/messages?limit=500', headers: auth })).json();
    const flagged = (await app.inject({ method: 'GET', url: '/api/messages?undelivered=1&limit=500', headers: auth })).json();
    const stored = rt.db.messagesSince(0);
    expect(all.totals.total).toBe(stored.length);
    expect(all.totals.undelivered).toBe(flagged.messages.length);
    expect(all.totals.failed).toBe(stored.filter((m) => m.status === 'failed').length);
    // Seeded Cloud API history is only in the database: the in-memory tracker
    // undercounts, which is why it is no longer used for these totals.
    expect(all.totals.total).toBeGreaterThan(rt.tracker.totals().total);
    // The Messages tab badge uses the same number.
    const fleet = (await app.inject({ method: 'GET', url: '/api/sessions', headers: auth })).json();
    expect(fleet.undeliveredMessages).toBe(all.totals.undelivered);
    const one = (await app.inject({ method: 'GET', url: '/api/messages?sessionId=cloud&limit=500', headers: auth })).json();
    expect(one.totals.total).toBe(stored.filter((m) => m.sessionId === 'cloud').length);
  });

  it('exposes the configured thresholds so the UI never hardcodes them', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/sessions', headers: auth })).json();
    expect(body.policy).toEqual({
      ackTimeoutMs: rt.config.ackTimeoutMs,
      degradedAfterMs: rt.monitor.policy.degradedAfterMs,
      deadAfterMs: rt.monitor.policy.deadAfterMs,
    });
  });
});
