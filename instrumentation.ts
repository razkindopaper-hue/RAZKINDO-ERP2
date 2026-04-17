export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Lightweight: only memory monitoring. RPCs deployed via /api/setup-rpc endpoint.
    try {
      await import('./src/lib/memory-init');
    } catch (e: any) {
      console.warn('[Instrumentation] MemoryGuard init skipped:', e.message?.substring(0, 80));
    }
    console.log('[Instrumentation] Minimal services initialized.');
  }
}
