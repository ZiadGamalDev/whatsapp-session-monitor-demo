import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TrackedMessage } from '../src/delivery/tracker.js';
import { registerExtensions } from '../src/extensions.js';
import { NO_RECEIPT, deliveryGap, toCsv } from '../src/reports/delivery-gap.js';
import type { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/server/app.js';
import { testRuntime } from './helpers.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 3, 12);

function msg(over: Partial<TrackedMessage>): TrackedMessage {
  return {
    id: 'x',
    sessionId: 'cloud',
    to: '+999 7100 0001',
    text: 't',
    source: 'cloud',
    providerMessageId: 'wamid.X',
    status: 'sent',
    createdAt: NOW - 1_000,
    sentAt: NOW - 1_000,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    error: null,
    undelivered: false,
    flaggedAt: null,
    lateDelivery: false,
    ...over,
  };
}

describe('deliveryGap', () => {
  const today = NOW - 60_000;
  const yesterday = NOW - DAY;
  const messages = [
    msg({ createdAt: today, status: 'read', deliveredAt: today, readAt: today }),
    msg({ createdAt: today, status: 'delivered', deliveredAt: today }),
    msg({ createdAt: today, status: 'failed', failedAt: today, error: '131026 Message undeliverable', sentAt: null }),
    msg({ createdAt: today, status: 'sent', undelivered: true }),
    msg({ createdAt: today, status: 'sent' }),
    msg({ createdAt: yesterday, status: 'failed', error: '131049 Message not delivered to maintain healthy ecosystem engagement' }),
    msg({ createdAt: yesterday, status: 'failed', error: 'not_connected', providerMessageId: null, source: 'synthetic', sessionId: 's01' }),
    msg({ createdAt: NOW - 10 * DAY, status: 'delivered', deliveredAt: NOW - 10 * DAY }),
  ];

  it('counts accepted vs delivered per UTC day, from receipts only', () => {
    const r = deliveryGap(messages, { now: NOW, days: 3, source: 'all' });
    expect(r.days.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    const d3 = r.days[2]!;
    expect(d3).toMatchObject({ attempted: 5, accepted: 5, delivered: 2, read: 1, failed: 1, noReceipt: 1, pending: 1, gap: 3, deliveryRate: 40 });
    expect(d3.reasons).toEqual({ '131026 Message undeliverable': 1, [NO_RECEIPT]: 1 });
    const d2 = r.days[1]!;
    expect(d2).toMatchObject({ attempted: 2, accepted: 1, failed: 2, gap: 1, deliveryRate: 0 });
    expect(r.days[0]).toMatchObject({ attempted: 0, deliveryRate: null });
    expect(r.totals).toMatchObject({ attempted: 7, accepted: 6, delivered: 2 });
    expect(r.reasons[0]!.count).toBeGreaterThanOrEqual(1);
  });

  it('filters by source', () => {
    expect(deliveryGap(messages, { now: NOW, days: 3, source: 'fleet' }).totals.attempted).toBe(1);
    expect(deliveryGap(messages, { now: NOW, days: 3, source: 'cloud' }).totals.attempted).toBe(6);
  });

  it('exports CSV with one row per day and one column per reason, safe for spreadsheets', () => {
    const csv = toCsv(deliveryGap(messages, { now: NOW, days: 3, source: 'all' }));
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^date,source,attempted,accepted,delivered,read,failed,no_receipt,pending,gap,delivery_rate_pct,reason: /);
    expect(lines[3]).toMatch(/^2026-01-03,all,5,5,2,1,1,1,1,3,40,/);
    const formula = toCsv({
      source: 'all',
      days: [],
      totals: deliveryGap([], { now: NOW, days: 1, source: 'all' }).totals,
      reasons: [{ reason: '=HYPERLINK("x")', count: 1 }],
    });
    expect(formula).toContain(`"reason: =HYPERLINK(""x"")"`);
    const leading = toCsv({ source: 'all', days: [], totals: deliveryGap([], { now: NOW, days: 1, source: 'all' }).totals, reasons: [{ reason: 'x', count: 1 }] });
    expect(leading.split('\n')[0]).toContain('reason: x');
  });
});

describe('delivery-gap API', () => {
  let rt: Runtime;
  let app: FastifyInstance;
  const auth = { authorization: 'Bearer demo-token' };
  beforeAll(async () => {
    rt = await testRuntime({ virtualTimeMs: 3 * 60_000 });
    app = await buildApp(rt, { register: (a) => registerExtensions(a, rt) });
    await app.ready();
    await rt.start();
  });
  afterAll(async () => {
    await app.close();
    await rt.stop();
  });

  it('returns 7 days of seeded + live data with failure reasons', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/reports/delivery-gap?days=7&source=cloud', headers: auth })).json();
    expect(res.days).toHaveLength(7);
    expect(res.totals.accepted).toBeGreaterThan(10);
    expect(res.totals.delivered).toBeLessThanOrEqual(res.totals.accepted);
    expect(res.reasons.map((r: { reason: string }) => r.reason.slice(0, 6))).toEqual(expect.arrayContaining(['131026']));
    const all = (await app.inject({ method: 'GET', url: '/api/reports/delivery-gap', headers: auth })).json();
    expect(all.source).toBe('all');
    expect(all.totals.attempted).toBeGreaterThan(res.totals.attempted);
  });

  it('serves CSV with a download name and requires the token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reports/delivery-gap.csv?source=cloud&days=3', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('delivery-gap-cloud.csv');
    expect(res.body.trim().split('\n')).toHaveLength(4);
    expect((await app.inject({ method: 'GET', url: '/api/reports/delivery-gap.csv' })).statusCode).toBe(401);
  });

  it('clamps days and ignores unknown sources', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/reports/delivery-gap?days=-5&source=evil', headers: auth })).json();
    expect(res.days).toHaveLength(7);
    expect(res.source).toBe('all');
    const big = (await app.inject({ method: 'GET', url: '/api/reports/delivery-gap?days=999', headers: auth })).json();
    expect(big.days).toHaveLength(31);
  });
});
