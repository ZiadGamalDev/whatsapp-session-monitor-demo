import type { TrackedMessage } from '../delivery/tracker.js';

/**
 * Delivery-gap report: per UTC day, how many messages the transport accepted
 * versus how many have a delivery receipt, and why the rest did not arrive.
 *
 * Definitions (all from receipts, never from the send call's HTTP status):
 *  - attempted: every message we tried to send that day
 *  - accepted:  the transport took it (has a provider message id)
 *  - delivered: has a `delivered` or `read` receipt
 *  - read:      has a `read` receipt
 *  - failed:    has a `failed` receipt (or was rejected before sending)
 *  - noReceipt: accepted, not failed, no delivery receipt after the ack timeout
 *  - pending:   accepted, still inside the ack timeout
 *  - gap:       accepted - delivered
 */

export type Source = 'all' | 'fleet' | 'cloud';

export interface DayRow {
  date: string;
  attempted: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  noReceipt: number;
  pending: number;
  gap: number;
  deliveryRate: number | null;
  reasons: Record<string, number>;
}

export interface GapReport {
  source: Source;
  days: DayRow[];
  totals: Omit<DayRow, 'date'>;
  reasons: Array<{ reason: string; count: number }>;
}

export const NO_RECEIPT = 'no delivery receipt (ack timeout)';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const empty = (): Omit<DayRow, 'date'> => ({
  attempted: 0,
  accepted: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  noReceipt: 0,
  pending: 0,
  gap: 0,
  deliveryRate: null,
  reasons: {},
});

export function failureReason(m: TrackedMessage): string | null {
  if (m.status === 'failed') return (m.error ?? 'failed').trim();
  if (m.deliveredAt === null && m.undelivered) return NO_RECEIPT;
  return null;
}

export function deliveryGap(messages: TrackedMessage[], opts: { now: number; days: number; source: Source }): GapReport {
  const start = Date.parse(`${day(opts.now - (opts.days - 1) * 86_400_000)}T00:00:00Z`);
  const byDay = new Map<string, Omit<DayRow, 'date'>>();
  for (let t = start; t <= opts.now; t += 86_400_000) byDay.set(day(t), empty());
  const totals = empty();

  for (const m of messages) {
    if (m.createdAt < start || m.createdAt > opts.now) continue;
    const isCloud = m.source === 'cloud';
    if (opts.source === 'cloud' && !isCloud) continue;
    if (opts.source === 'fleet' && isCloud) continue;
    const row = byDay.get(day(m.createdAt));
    if (!row) continue;
    for (const r of [row, totals]) {
      r.attempted++;
      const accepted = m.providerMessageId !== null;
      if (accepted) r.accepted++;
      if (m.deliveredAt !== null) r.delivered++;
      if (m.readAt !== null) r.read++;
      if (m.status === 'failed') r.failed++;
      else if (accepted && m.deliveredAt === null) {
        if (m.undelivered) r.noReceipt++;
        else r.pending++;
      }
      const reason = failureReason(m);
      if (reason) r.reasons[reason] = (r.reasons[reason] ?? 0) + 1;
    }
  }
  const finish = <T extends Omit<DayRow, 'date'>>(r: T): T => {
    r.gap = r.accepted - r.delivered;
    r.deliveryRate = r.accepted ? Math.round((r.delivered / r.accepted) * 1000) / 10 : null;
    return r;
  };
  const days = [...byDay.entries()].map(([date, r]) => ({ date, ...finish(r) }));
  finish(totals);
  const reasons = Object.entries(totals.reasons)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { source: opts.source, days, totals, reasons };
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  // Neutralise spreadsheet formulas and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(r: GapReport): string {
  const reasonCols = r.reasons.map((x) => x.reason);
  const header = [
    'date',
    'source',
    'attempted',
    'accepted',
    'delivered',
    'read',
    'failed',
    'no_receipt',
    'pending',
    'gap',
    'delivery_rate_pct',
    ...reasonCols.map((x) => `reason: ${x}`),
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const d of r.days) {
    lines.push(
      [
        d.date,
        r.source,
        d.attempted,
        d.accepted,
        d.delivered,
        d.read,
        d.failed,
        d.noReceipt,
        d.pending,
        d.gap,
        d.deliveryRate,
        ...reasonCols.map((x) => d.reasons[x] ?? 0),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
