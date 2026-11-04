/**
 * Time source used by the provider, monitor and tracker.
 *
 * `SystemClock` delegates to the global timer functions on every call, so
 * Vitest fake timers (`vi.useFakeTimers()`) control it in tests.
 * `VirtualClock` is a manual clock used to fast-forward the simulated fleet
 * to a fixed point in time (deterministic screenshots).
 */
export type TimerHandle = { readonly id: number };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined | null): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined | null): void;
}

export class SystemClock implements Clock {
  private seq = 0;
  private readonly handles = new Map<number, ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    const h = setTimeout(() => {
      this.handles.delete(id);
      fn();
    }, ms);
    this.handles.set(id, h);
    return { id };
  }

  clearTimeout(handle: TimerHandle | undefined | null): void {
    if (!handle) return;
    const h = this.handles.get(handle.id);
    if (h !== undefined) clearTimeout(h);
    this.handles.delete(handle.id);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.handles.set(id, setInterval(fn, ms));
    return { id };
  }

  clearInterval(handle: TimerHandle | undefined | null): void {
    if (!handle) return;
    const h = this.handles.get(handle.id);
    if (h !== undefined) clearInterval(h);
    this.handles.delete(handle.id);
  }
}

interface VirtualTimer {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

export class VirtualClock implements Clock {
  private current: number;
  private seq = 0;
  private timers = new Map<number, VirtualTimer>();

  constructor(startAt: number) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.current + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle | undefined | null): void {
    if (handle) this.timers.delete(handle.id);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    const every = Math.max(1, ms);
    this.timers.set(id, { id, at: this.current + every, fn, every });
    return { id };
  }

  clearInterval(handle: TimerHandle | undefined | null): void {
    this.clearTimeout(handle);
  }

  /** Runs every timer due within `ms`, in time order (ties by creation order). */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let next: VirtualTimer | undefined;
      for (const t of this.timers.values()) {
        if (t.at > target) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
      }
      if (!next) break;
      this.current = Math.max(this.current, next.at);
      if (next.every) {
        next.at += next.every;
      } else {
        this.timers.delete(next.id);
      }
      next.fn();
    }
    this.current = target;
  }
}
