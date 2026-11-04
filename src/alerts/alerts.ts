import type { EventEmitter } from 'node:events';
import type { Clock } from '../clock.js';
import type { SessionMonitor, Transition } from '../monitor/monitor.js';
import type { SessionState } from '../monitor/state-machine.js';
import type { AlertRow, MonitorDb } from '../store/db.js';
import type { TelegramNotifierStub } from './telegram.js';
import type { WebhookSender } from './webhook.js';

export interface AlertPayload {
  id: number;
  type: 'state_change' | 'recovered';
  sessionId: string;
  label: string;
  from: SessionState;
  to: SessionState;
  reason: string;
  at: string;
  simulated: true;
}

const BAD: SessionState[] = ['degraded', 'reconnecting', 'logged_out', 'stuck'];

/**
 * Which transitions page someone:
 *  - entering any problem state (degraded, reconnecting, logged_out, stuck)
 *  - recovering to `connected` from a problem state
 * Start-up (`connecting -> connected`) and reconnect attempts inside
 * `reconnecting` do not.
 */
export function alertTypeFor(t: Pick<Transition, 'from' | 'to'>): AlertPayload['type'] | null {
  if (BAD.includes(t.to)) return 'state_change';
  if (t.to === 'connected' && BAD.includes(t.from)) return 'recovered';
  return null;
}

export class AlertManager {
  constructor(
    private readonly deps: {
      clock: Clock;
      db: MonitorDb;
      bus: EventEmitter;
      monitor: SessionMonitor;
      webhook: WebhookSender | null;
      telegram: TelegramNotifierStub;
    },
  ) {}

  start(): void {
    this.deps.monitor.on('transition', (t: Transition) => this.onTransition(t));
  }

  onTransition(t: Transition): AlertRow | null {
    const type = alertTypeFor(t);
    if (!type) return null;
    const { db, bus, webhook, telegram, monitor } = this.deps;
    const channels: string[] = [];
    if (webhook) channels.push('webhook');
    if (telegram.enabled) channels.push('telegram (stub)');
    const row = db.insertAlert({
      sessionId: t.sessionId,
      at: t.at,
      type,
      fromState: t.from,
      toState: t.to,
      reason: t.reason,
      deliveryStatus: webhook ? 'pending' : 'not_configured',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      channels,
    });
    const payload: AlertPayload = {
      id: row.id,
      type,
      sessionId: t.sessionId,
      label: monitor.snapshot(t.sessionId)?.label ?? t.sessionId,
      from: t.from,
      to: t.to,
      reason: t.reason,
      at: new Date(t.at).toISOString(),
      simulated: true,
    };
    telegram.notify(payload);
    bus.emit('alert', row);
    if (webhook) void this.deliver(row, payload, webhook);
    return row;
  }

  private async deliver(row: AlertRow, payload: AlertPayload, webhook: WebhookSender): Promise<void> {
    const { db, bus, clock } = this.deps;
    await webhook.deliver(`alert-${row.id}`, payload, (info) => {
      const patch = {
        deliveryStatus: info.ok ? 'delivered' : info.willRetry ? 'retrying' : 'failed',
        attempts: info.attempt,
        lastAttemptAt: clock.now(),
        lastError: info.error,
      } as const;
      db.updateAlertDelivery(row.id, patch);
      bus.emit('alert', { ...row, ...patch });
    });
  }
}
