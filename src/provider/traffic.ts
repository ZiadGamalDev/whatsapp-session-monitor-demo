import type { Clock, TimerHandle } from '../clock.js';
import type { DeliveryTracker } from '../delivery/tracker.js';
import type { SessionMonitor } from '../monitor/monitor.js';
import { deriveSeed, mulberry32 } from '../rng.js';

/**
 * Synthetic traffic for the simulator: one message at a time to a fake
 * recipient inside the simulator, so delivery tracking has something to
 * track. It never leaves the process and has no list/broadcast feature.
 *
 * It sends whenever the transport *looks* open (connected or degraded),
 * which is what a naive sender does; that is how silent drops turn into
 * "sent but never delivered" messages.
 */
export class SyntheticTraffic {
  private handle?: TimerHandle;
  private readonly rand: () => number;
  private n = 0;

  constructor(
    private readonly opts: {
      clock: Clock;
      monitor: SessionMonitor;
      tracker: DeliveryTracker;
      seed: number;
      intervalMs: number;
    },
  ) {
    this.rand = mulberry32(deriveSeed(opts.seed, 'traffic'));
  }

  start(): void {
    this.handle = this.opts.clock.setInterval(() => this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    this.opts.clock.clearInterval(this.handle);
  }

  private tick(): void {
    const candidates = this.opts.monitor
      .snapshots()
      .filter((s) => s.lastEvent === 'open' && (s.state === 'connected' || s.state === 'degraded'))
      .map((s) => s.id)
      .sort();
    if (candidates.length === 0) return;
    const sessionId = candidates[Math.floor(this.rand() * candidates.length)]!;
    const n = ++this.n;
    const to = `+999 7000 ${String(Math.floor(this.rand() * 10_000)).padStart(4, '0')}`;
    void this.opts.tracker.send(sessionId, to, `Synthetic test message #${n}`, 'synthetic');
  }
}
