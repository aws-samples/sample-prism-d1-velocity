/**
 * When to run prism-cli: one run at a time, requests debounced, a request
 * during a run queued for one more run after it. No vscode import.
 */

export const DEBOUNCE_MS = 2_000;
/** Window focus refreshes only data older than this. */
export const FOCUS_STALE_MS = 60_000;
export const INTERVAL_MS = 5 * 60_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class Refresher {
  private timer: unknown = null;
  private running = false;
  private queued = false;
  private wantFresh = false;
  private disposed = false;
  /** When the last run finished; null before the first. */
  lastRunAt: number | null = null;

  constructor(private readonly run: (fresh: boolean) => Promise<void>, private readonly clock: Clock = realClock, private readonly debounceMs = DEBOUNCE_MS) {}

  /** Asks for a run. `immediate` skips the debounce (activation, the Refresh command). `fresh` sticks until a run uses it. */
  request(opts: { fresh?: boolean; immediate?: boolean } = {}): void {
    if (this.disposed) return;
    if (opts.fresh) this.wantFresh = true;
    if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
    if (opts.immediate) { this.fire(); return; }
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.fire(); }, this.debounceMs);
  }

  /** Window gained focus: refresh when the data is older than FOCUS_STALE_MS. */
  focus(): void {
    if (this.running) return;
    if (this.lastRunAt === null || this.clock.now() - this.lastRunAt > FOCUS_STALE_MS) this.request();
  }

  get busy(): boolean { return this.running; }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private fire(): void {
    if (this.running) { this.queued = true; return; }
    this.running = true;
    const fresh = this.wantFresh;
    this.wantFresh = false;
    this.run(fresh).catch(() => { /* run reports its own errors in the status bar */ }).finally(() => {
      this.running = false;
      this.lastRunAt = this.clock.now();
      if (this.queued && !this.disposed) { this.queued = false; this.fire(); }
    });
  }
}
