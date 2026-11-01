/** Tracks only verified request starts. No prompt text or log contents are stored. */
export class ActivityTracker {
  private readonly requests = new Map<string, number>();
  private manualUntil = 0;

  start(id: string, now: number): void {
    // Duplicate log records must not indefinitely extend a stale request.
    if (!this.requests.has(id)) this.requests.set(id, now);
  }

  end(id: string): void { this.requests.delete(id); }

  startManual(now: number): void { this.manualUntil = now + 30 * 60_000; }
  stopManual(): void { this.manualUntil = 0; }
  clear(): void { this.requests.clear(); this.stopManual(); }

  expire(now: number, staleAfterMs: number): number {
    let expired = 0;
    for (const [id, started] of this.requests) {
      if (now - started >= staleAfterMs) { this.requests.delete(id); expired++; }
    }
    if (this.manualUntil <= now) this.stopManual();
    return expired;
  }

  snapshot(now: number): { automatic: number; manual: boolean; manualUntil: number; awake: boolean } {
    const manual = this.manualUntil > now;
    return { automatic: this.requests.size, manual, manualUntil: this.manualUntil, awake: manual || this.requests.size > 0 };
  }
}
