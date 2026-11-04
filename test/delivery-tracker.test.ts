import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemClock } from '../src/clock.js';
import { DeliveryTracker, type TrackedMessage } from '../src/delivery/tracker.js';
import { SimulatedProvider } from '../src/provider/simulated.js';
import type { Credentials } from '../src/provider/types.js';

const NONE = { silent_drop: 0, logged_out: 0, credential_error_loop: 0, stuck_reconnecting: 0, never_acked: 0 };

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-01-01T09:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

function manual(ackTimeoutMs = 60_000) {
  const tracker = new DeliveryTracker({ clock: new SystemClock(), ackTimeoutMs });
  const flagged: TrackedMessage[] = [];
  tracker.on('undelivered', (m: TrackedMessage) => flagged.push(m));
  const sent = (pid: string, sessionId = 's01') => {
    const m = tracker.create(sessionId, '+999 1', 'hello');
    return tracker.markAccepted(m.id, pid);
  };
  return { tracker, flagged, sent };
}

describe('DeliveryTracker', () => {
  it('moves sent -> delivered -> read', () => {
    const { tracker, sent } = manual();
    const m = sent('p1');
    expect(m.status).toBe('sent');
    tracker.applyAck('p1', 'delivered');
    tracker.applyAck('p1', 'read');
    expect(tracker.get(m.id)).toMatchObject({ status: 'read', undelivered: false });
  });

  it('flags "sent but never delivered" exactly at the ack timeout', () => {
    const { tracker, flagged, sent } = manual(60_000);
    const m = sent('p1');
    vi.advanceTimersByTime(59_999);
    expect(tracker.get(m.id)!.undelivered).toBe(false);
    expect(tracker.undeliveredCount('s01')).toBe(0);
    vi.advanceTimersByTime(1);
    expect(tracker.get(m.id)!.undelivered).toBe(true);
    expect(tracker.undeliveredCount('s01')).toBe(1);
    expect(flagged.map((f) => f.id)).toEqual([m.id]);
  });

  it('does not flag messages delivered in time', () => {
    const { tracker, flagged, sent } = manual();
    sent('p1');
    vi.advanceTimersByTime(30_000);
    tracker.applyAck('p1', 'delivered');
    vi.advanceTimersByTime(10 * 60_000);
    expect(flagged).toEqual([]);
    expect(tracker.undeliveredCount('s01')).toBe(0);
  });

  it('counts undelivered per session', () => {
    const { tracker, sent } = manual();
    sent('a1', 's01');
    sent('a2', 's01');
    sent('b1', 's02');
    sent('c1', 's03');
    tracker.applyAck('c1', 'delivered');
    vi.advanceTimersByTime(61_000);
    expect(tracker.undeliveredCount('s01')).toBe(2);
    expect(tracker.undeliveredCount('s02')).toBe(1);
    expect(tracker.undeliveredCount('s03')).toBe(0);
  });

  it('a late delivery clears the flag but remembers it happened', () => {
    const { tracker, sent } = manual();
    const m = sent('p1');
    vi.advanceTimersByTime(61_000);
    tracker.applyAck('p1', 'delivered');
    expect(tracker.get(m.id)).toMatchObject({ status: 'delivered', undelivered: false, lateDelivery: true });
    expect(tracker.undeliveredCount('s01')).toBe(0);
    expect(tracker.flaggedTotal('s01')).toBe(1);
  });

  it('failed is terminal and also clears the undelivered flag', () => {
    const { tracker, sent } = manual();
    const m = sent('p1');
    vi.advanceTimersByTime(61_000);
    tracker.applyAck('p1', 'failed', { error: '131026 Message undeliverable' });
    tracker.applyAck('p1', 'delivered');
    expect(tracker.get(m.id)).toMatchObject({ status: 'failed', undelivered: false, error: '131026 Message undeliverable' });
    expect(tracker.undeliveredCount('s01')).toBe(0);
  });

  it('never moves backwards on out-of-order receipts', () => {
    const { tracker, sent } = manual();
    const m = sent('p1');
    tracker.applyAck('p1', 'read');
    tracker.applyAck('p1', 'delivered');
    tracker.applyAck('p1', 'sent');
    expect(tracker.get(m.id)!.status).toBe('read');
    expect(tracker.get(m.id)!.deliveredAt).not.toBeNull();
  });

  it('counts receipts for unknown ids instead of throwing', () => {
    const { tracker } = manual();
    expect(tracker.applyAck('nope', 'delivered')).toBe(false);
    expect(tracker.unmatchedReceipts()).toBe(1);
  });

  it('end to end with the simulator: never-acked session accumulates undelivered messages', async () => {
    const clock = new SystemClock();
    const provider = new SimulatedProvider({
      clock,
      sessionCount: 2,
      mix: NONE,
      overrides: { s01: 'never_acked', s02: 'healthy' },
      faultWindowMs: { min: 3_000, max: 3_000 },
    });
    const tracker = new DeliveryTracker({ clock, provider, ackTimeoutMs: 60_000 });
    const creds = (id: string): Credentials => ({ sessionId: id, generation: 1, fingerprint: 'x', createdAt: 0 });
    await provider.connect('s01', creds('s01'));
    await provider.connect('s02', creds('s02'));
    vi.advanceTimersByTime(5_000);
    for (let i = 0; i < 5; i++) {
      await tracker.send('s01', '+999 1', `n${i}`);
      await tracker.send('s02', '+999 2', `h${i}`);
    }
    vi.advanceTimersByTime(2 * 60_000);
    expect(tracker.undeliveredCount('s01')).toBe(5);
    expect(tracker.undeliveredCount('s02')).toBe(0);
    expect(tracker.list({ sessionId: 's01', undeliveredOnly: true })).toHaveLength(5);
  });

  it('marks a message failed when the provider refuses it', async () => {
    const clock = new SystemClock();
    const provider = new SimulatedProvider({ clock, sessionCount: 1, mix: NONE });
    const tracker = new DeliveryTracker({ clock, provider });
    const m = await tracker.send('s01', '+999 1', 'x');
    expect(m).toMatchObject({ status: 'failed', error: 'not_connected' });
  });
});
