import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemClock } from '../src/clock.js';
import { MemoryCredentialStore } from '../src/monitor/credentials.js';
import { SessionMonitor, type TimelineEntry, type Transition } from '../src/monitor/monitor.js';
import { DEFAULT_POLICY } from '../src/monitor/state-machine.js';
import { SimulatedProvider, type Scenario } from '../src/provider/simulated.js';

const NONE = { silent_drop: 0, logged_out: 0, credential_error_loop: 0, stuck_reconnecting: 0, never_acked: 0 };

function setup(scenario: Scenario) {
  const clock = new SystemClock();
  const provider = new SimulatedProvider({
    clock,
    seed: 3,
    sessionCount: 1,
    mix: NONE,
    overrides: { s01: scenario },
    faultWindowMs: { min: 30_000, max: 30_000 },
  });
  const credentials = new MemoryCredentialStore();
  const monitor = new SessionMonitor({ provider, clock, credentials, policy: { backoffJitter: 0 } });
  const transitions: Transition[] = [];
  const timeline: TimelineEntry[] = [];
  monitor.on('transition', (t: Transition) => transitions.push(t));
  monitor.on('timeline', (e: TimelineEntry) => timeline.push(e));
  const connectSpy = vi.spyOn(provider, 'connect');
  const wipeSpy = vi.spyOn(credentials, 'wipe');
  monitor.start();
  return { clock, provider, credentials, monitor, transitions, timeline, connectSpy, wipeSpy };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-01-01T09:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SessionMonitor (fake timers)', () => {
  it('healthy: connects and stays connected', () => {
    const { monitor } = setup('healthy');
    vi.advanceTimersByTime(60_000);
    const s = monitor.snapshot('s01')!;
    expect(s.state).toBe('connected');
    expect(s.heartbeatAgeMs).toBeLessThan(DEFAULT_POLICY.degradedAfterMs);
    expect(s.reconnectCount).toBe(0);
  });

  it('silent drop: provider still says "open", monitor goes degraded then reconnects', () => {
    const { monitor, transitions, credentials, wipeSpy } = setup('silent_drop');
    const fp = credentials.get('s01')!.fingerprint;
    // The scripted drop happens 60-200 s after open.
    let sawDegradedWithOpen = false;
    for (let i = 0; i < 300; i++) {
      vi.advanceTimersByTime(1_000);
      const s = monitor.snapshot('s01')!;
      if (s.state === 'degraded' && s.lastEvent === 'open') sawDegradedWithOpen = true;
      if (transitions.some((t) => t.reason === 'heartbeat_timeout')) break;
    }
    expect(sawDegradedWithOpen).toBe(true);
    const timeout = transitions.find((t) => t.reason === 'heartbeat_timeout')!;
    expect(timeout).toMatchObject({ from: 'degraded', to: 'reconnecting' });
    vi.advanceTimersByTime(5_000);
    const s = monitor.snapshot('s01')!;
    expect(s.state).toBe('connected');
    expect(s.reconnectCount).toBe(1);
    expect(s.credentialFingerprint).toBe(fp);
    expect(wipeSpy).not.toHaveBeenCalled();
  });

  it('logged out (401): parks the session, stops retrying, keeps credentials', () => {
    const { monitor, connectSpy, wipeSpy, credentials } = setup('logged_out');
    const before = credentials.get('s01')!;
    vi.advanceTimersByTime(31_000);
    expect(monitor.snapshot('s01')!.state).toBe('logged_out');
    const calls = connectSpy.mock.calls.length;
    vi.advanceTimersByTime(30 * 60_000);
    expect(connectSpy.mock.calls.length).toBe(calls);
    expect(credentials.get('s01')).toEqual(before);
    expect(wipeSpy).not.toHaveBeenCalled();
  });

  it('relink is the only thing that replaces credentials, and it recovers a logged-out session', () => {
    const { monitor, wipeSpy, credentials, timeline } = setup('logged_out');
    vi.advanceTimersByTime(31_000);
    const old = credentials.get('s01')!.fingerprint;
    monitor.relink('s01');
    expect(wipeSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    const s = monitor.snapshot('s01')!;
    expect(s.state).toBe('connected');
    expect(s.credentialGeneration).toBe(2);
    expect(s.credentialFingerprint).not.toBe(old);
    expect(s.credentialWipes).toBe(1);
    expect(timeline.map((e) => e.code)).toContain('credentials_replaced');
  });

  it('credential-error loop: ends stuck with credentials intact', () => {
    const { monitor, wipeSpy, credentials } = setup('credential_error_loop');
    const fp = credentials.get('s01')!.fingerprint;
    vi.advanceTimersByTime(10 * 60_000);
    const s = monitor.snapshot('s01')!;
    expect(s.state).toBe('stuck');
    expect(s.stuckReason).toBe('credential_error_loop');
    expect(s.needsRelink).toBe(true);
    expect(s.credentialFingerprint).toBe(fp);
    expect(wipeSpy).not.toHaveBeenCalled();
  });

  it('stuck reconnecting: gives up after the attempt cap with exponential backoff', () => {
    const { monitor, connectSpy, timeline } = setup('stuck_reconnecting');
    vi.advanceTimersByTime(10 * 60_000);
    const s = monitor.snapshot('s01')!;
    expect(s.state).toBe('stuck');
    expect(s.stuckReason).toBe('reconnect_cap');
    expect(connectSpy).toHaveBeenCalledTimes(1 + DEFAULT_POLICY.maxAttempts);
    const delays = timeline.filter((e) => e.code === 'reconnect_scheduled').map((e) => e.detail!.delayMs);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    // Parked sessions are not retried forever.
    vi.advanceTimersByTime(60 * 60_000);
    expect(connectSpy).toHaveBeenCalledTimes(1 + DEFAULT_POLICY.maxAttempts);
  });

  it('relink recovers a stuck session', () => {
    const { monitor } = setup('stuck_reconnecting');
    vi.advanceTimersByTime(10 * 60_000);
    expect(monitor.snapshot('s01')!.state).toBe('stuck');
    monitor.relink('s01');
    vi.advanceTimersByTime(5_000);
    expect(monitor.snapshot('s01')!.state).toBe('connected');
  });
});
