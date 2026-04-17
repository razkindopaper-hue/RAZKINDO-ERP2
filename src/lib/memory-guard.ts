// =====================================================================
// MEMORY GUARD - Memory Leak Prevention & Monitoring
//
// Monitors process memory usage and provides:
// - Periodic memory stat checks with warning/critical thresholds
// - Cleanup suggestion callbacks when memory is critical
// - Integration hook with graceful degradation
//
// IMPORTANT: V8's heap is naturally 85-95% utilized — this is NORMAL.
// CRITICAL/WARNING should only trigger when heap grows significantly
// beyond the initial allocation (suggesting a leak).
// =====================================================================

interface MemoryStats {
  used: number;       // MB - heap used
  total: number;      // MB - heap total
  percent: number;    // 0-100 - usage percentage
  rss: number;        // MB - resident set size
  heapUsedMB: number;
  heapTotalMB: number;
  underPressure: boolean;
}

type CleanupCallback = () => void;

export class MemoryGuard {
  private static instance: MemoryGuard;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private criticalCallbacks: CleanupCallback[] = [];
  private lastWarningLoggedAt: number = 0;
  private baselineHeapMB: number = 0;
  private baselineRefreshed: boolean = false;
  private criticalDebounceMs: number = 300_000; // 5 min between logs

  private constructor() {}

  /** Get singleton instance */
  static getInstance(): MemoryGuard {
    if (!MemoryGuard.instance) {
      MemoryGuard.instance = new MemoryGuard();
    }
    return MemoryGuard.instance;
  }

  /**
   * Start periodic memory monitoring.
   * @param intervalMs - Check interval in ms (default: 120000 = 2min)
   */
  start(intervalMs: number = 120_000): void {
    if (this.checkInterval) return;

    // Record baseline heap size at startup
    const memInfo = process.memoryUsage();
    this.baselineHeapMB = memInfo.heapTotal / (1024 * 1024);

    // Run an immediate check
    this.check();

    // Unref to not prevent Node.js exit
    this.checkInterval = setInterval(() => this.check(), intervalMs);
    if (this.checkInterval && typeof this.checkInterval === 'object' && 'unref' in this.checkInterval) {
      (this.checkInterval as any).unref();
    }
  }

  /** Stop periodic monitoring */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /** Get current memory stats */
  getStats(): MemoryStats {
    const mem = process.memoryUsage();
    const heapUsedMB = mem.heapUsed / (1024 * 1024);
    const heapTotalMB = mem.heapTotal / (1024 * 1024);
    const rssMB = mem.rss / (1024 * 1024);
    const percent = heapTotalMB > 0 ? Math.min((heapUsedMB / heapTotalMB) * 100, 100) : 0;

    // "Under pressure" only if heap has grown significantly beyond baseline
    // AND usage is high. A high percentage alone is not pressure — V8 naturally
    // fills the heap to ~95% and grows it on demand.
    const heapGrowthMB = heapTotalMB - this.baselineHeapMB;
    // For LOW_MEMORY_MODE: lower thresholds; otherwise use generous thresholds
    // since V8 naturally fills heap to 95%+ and growth from baseline is normal during startup
    const growthThreshold = process.env.LOW_MEMORY_MODE === '1' ? 200 : 400;
    const pressureThreshold = process.env.LOW_MEMORY_MODE === '1' ? 95 : 98;
    const underPressure = percent >= pressureThreshold && heapGrowthMB > growthThreshold;

    return {
      used: Math.round(heapUsedMB * 100) / 100,
      total: Math.round(heapTotalMB * 100) / 100,
      percent: Math.round(percent * 100) / 100,
      rss: Math.round(rssMB * 100) / 100,
      heapUsedMB: Math.round(heapUsedMB * 100) / 100,
      heapTotalMB: Math.round(heapTotalMB * 100) / 100,
      underPressure,
    };
  }

  /** Check if memory is under pressure */
  isUnderPressure(): boolean {
    return this.getStats().underPressure;
  }

  /**
   * Register a cleanup callback that runs when memory is critical.
   */
  onCritical(callback: CleanupCallback): void {
    this.criticalCallbacks.push(callback);
  }

  /**
   * Suggest cleanup — call all registered cleanup callbacks.
   */
  suggestCleanup(): void {
    for (const cb of this.criticalCallbacks) {
      try { cb(); } catch { /* silent */ }
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private check(): void {
    this.maybeRefreshBaseline();
    const stats = this.getStats();
    const now = Date.now();

    // Only log if under actual pressure (heap grew significantly)
    // AND enough time has passed since last log
    const canLog = now - this.lastWarningLoggedAt > this.criticalDebounceMs;

    if (stats.underPressure) {
      if (canLog) {
        console.error(
          `[MemoryGuard] CRITICAL: Heap at ${stats.percent.toFixed(1)}% ` +
          `(${stats.heapUsedMB.toFixed(1)}MB / ${stats.heapTotalMB.toFixed(1)}MB). ` +
          `RSS: ${stats.rss.toFixed(1)}MB. ` +
          `Consider restarting or investigating memory leaks.`
        );
        this.lastWarningLoggedAt = now;
      }
      this.suggestCleanup();
    }
    // Normal V8 heap utilization (85-95%) is NOT logged — it's expected behavior.
  }

  /**
   * Refresh baseline after 1 hour of uptime so organic heap growth
   * is not mistaken for a memory leak (BUG-03 fix).
   */
  private maybeRefreshBaseline(): void {
    if (this.baselineRefreshed) return;
    const uptimeSeconds = process.uptime();
    if (uptimeSeconds > 3600) { // after 1 hour
      const mem = process.memoryUsage();
      const newBaseline = mem.heapTotal / (1024 * 1024);
      console.log(
        `[MemoryGuard] Memperbarui baseline: ${this.baselineHeapMB.toFixed(0)}MB → ${newBaseline.toFixed(0)}MB`
      );
      this.baselineHeapMB = newBaseline;
      this.baselineRefreshed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton export
// ---------------------------------------------------------------------------

export const memoryGuard = MemoryGuard.getInstance();
