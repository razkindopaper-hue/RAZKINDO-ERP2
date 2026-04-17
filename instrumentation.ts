// =====================================================================
// Next.js Instrumentation Hook
//
// Runs once when the Next.js server starts (Node.js runtime only).
// Initializes only essential server-side services.
// Heavy services (PerformanceMonitor, ConcurrencyManager, BatchOptimizer)
// are lazy-initialized on first use instead of eagerly at startup.
// =====================================================================

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] Skipping all instrumentation for debugging.');
    // All instrumentation temporarily disabled to debug server crash.
    // Re-enable after identifying root cause.
  }
}
