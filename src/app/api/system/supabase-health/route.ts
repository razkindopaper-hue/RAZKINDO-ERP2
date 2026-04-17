import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';

// ---- Server-side cache (15 second TTL) ----
let cachedHealth: { data: Record<string, unknown>; timestamp: number } | null = null;
const HEALTH_CACHE_TTL = 15_000;

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Return cached health if fresh
    if (cachedHealth && Date.now() - cachedHealth.timestamp < HEALTH_CACHE_TTL) {
      return NextResponse.json({ success: true, data: cachedHealth.data });
    }

    const checks: {
      name: string;
      status: 'connected' | 'degraded' | 'disconnected';
      latencyMs: number;
      detail: string;
    }[] = [];

    // Run all health checks in parallel
    const [restResult, tablesResult, prismaResult] = await Promise.all([
      // 1. Supabase REST API health check
      (async () => {
        const start = performance.now();
        try {
          const { error, count } = await db.from('settings').select('*', { count: 'exact', head: true });
          const latency = Math.round(performance.now() - start);
          return {
            name: 'REST API',
            status: error ? 'disconnected' as const : latency > 2000 ? 'degraded' as const : 'connected' as const,
            latencyMs: latency,
            detail: error ? `Error: ${error.message?.slice(0, 60)}` : `${count || 0} settings`,
          };
        } catch (err: unknown) {
          return {
            name: 'REST API',
            status: 'disconnected' as const,
            latencyMs: Math.round(performance.now() - start),
            detail: `Connection failed: ${err instanceof Error ? err.message.slice(0, 60) : 'Unknown'}`,
          };
        }
      })(),

      // 2. Check critical tables accessibility (PARALLEL)
      (async () => {
        const criticalTables = ['users', 'transactions', 'products', 'customers'];
        const start = performance.now();
        const results = await Promise.all(
          criticalTables.map(async (table) => {
            try {
              const { error } = await db.from(table).select('id').limit(1);
              return !error;
            } catch { return false; }
          })
        );
        const tablesOk = results.filter(Boolean).length;
        const latency = Math.round(performance.now() - start);
        return {
          name: 'Tabel Kritis',
          status: tablesOk === criticalTables.length ? 'connected' as const : tablesOk > 0 ? 'degraded' as const : 'disconnected' as const,
          latencyMs: latency,
          detail: `${tablesOk}/${criticalTables.length} tabel dapat diakses`,
        };
      })(),

      // 3. Prisma direct connection check
      (async () => {
        const start = performance.now();
        try {
          const { prisma } = await import('@/lib/supabase');
          await prisma.$queryRaw`SELECT 1`;
          const latency = Math.round(performance.now() - start);
          return {
            name: 'Prisma Direct',
            status: latency > 3000 ? 'degraded' as const : 'connected' as const,
            latencyMs: latency,
            detail: 'Koneksi langsung PostgreSQL OK',
          };
        } catch (err: unknown) {
          return {
            name: 'Prisma Direct',
            status: 'disconnected' as const,
            latencyMs: Math.round(performance.now() - start),
            detail: `Gagal: ${err instanceof Error ? err.message.slice(0, 60) : 'Unknown'}`,
          };
        }
      })(),
    ]);

    checks.push(restResult, tablesResult, prismaResult);

    // Overall status
    const hasDisconnected = checks.some(c => c.status === 'disconnected');
    const hasDegraded = checks.some(c => c.status === 'degraded');
    const overall: 'connected' | 'degraded' | 'disconnected' = hasDisconnected ? 'disconnected' : hasDegraded ? 'degraded' : 'connected';
    const avgLatency = checks.length > 0 ? Math.round(checks.reduce((s, c) => s + c.latencyMs, 0) / checks.length) : 0;

    const data = { overall, avgLatencyMs: avgLatency, checks, timestamp: new Date().toISOString() };

    // Cache the result
    cachedHealth = { data, timestamp: Date.now() };

    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Supabase health error:', message);
    return NextResponse.json({
      success: true,
      data: {
        overall: 'disconnected' as const,
        avgLatencyMs: 0,
        checks: [{ name: 'General', status: 'disconnected' as const, latencyMs: 0, detail: `Error: ${message.slice(0, 60)}` }],
        timestamp: new Date().toISOString(),
      },
    });
  }
}
