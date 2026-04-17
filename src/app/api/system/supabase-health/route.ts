import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const checks: {
      name: string;
      status: 'connected' | 'degraded' | 'disconnected';
      latencyMs: number;
      detail: string;
    }[] = [];

    // 1. Supabase REST API health check
    const restStart = performance.now();
    try {
      const { error, count } = await db.from('settings').select('*', { count: 'exact', head: true });
      const restLatency = Math.round(performance.now() - restStart);
      checks.push({
        name: 'REST API',
        status: error ? 'disconnected' : restLatency > 2000 ? 'degraded' : 'connected',
        latencyMs: restLatency,
        detail: error ? `Error: ${error.message?.slice(0, 60)}` : `${count || 0} settings loaded`,
      });
    } catch (err: any) {
      checks.push({
        name: 'REST API',
        status: 'disconnected',
        latencyMs: Math.round(performance.now() - restStart),
        detail: `Connection failed: ${err.message?.slice(0, 60)}`,
      });
    }

    // 2. Database read/write test
    const rwStart = performance.now();
    try {
      // Read
      const { data: testData, error: readErr } = await db.from('settings').select('key, value').eq('key', '_health_check').maybeSingle();
      if (readErr) throw readErr;

      // Write (upsert a health check key)
      const testValue = Date.now().toString();
      if (testData) {
        await db.from('settings').update({ value: testValue, updated_at: new Date().toISOString() }).eq('key', '_health_check');
      } else {
        const { generateId } = await import('@/lib/generate-id');
        await db.from('settings').insert({ id: generateId(), key: '_health_check', value: testValue, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }

      const rwLatency = Math.round(performance.now() - rwStart);
      checks.push({
        name: 'Read/Write',
        status: rwLatency > 3000 ? 'degraded' : 'connected',
        latencyMs: rwLatency,
        detail: 'Read & write berhasil',
      });
    } catch (err: any) {
      checks.push({
        name: 'Read/Write',
        status: 'disconnected',
        latencyMs: Math.round(performance.now() - rwStart),
        detail: `Gagal: ${err.message?.slice(0, 60)}`,
      });
    }

    // 3. Check critical tables accessibility
    const criticalTables = ['users', 'transactions', 'products', 'customers'];
    let tablesOk = 0;
    let tablesTotal = criticalTables.length;
    const tableStart = performance.now();
    for (const table of criticalTables) {
      try {
        const { error } = await db.from(table).select('id').limit(1);
        if (!error) tablesOk++;
      } catch { /* table not accessible */ }
    }
    const tableLatency = Math.round(performance.now() - tableStart);
    checks.push({
      name: 'Tabel Kritis',
      status: tablesOk === tablesTotal ? 'connected' : tablesOk > 0 ? 'degraded' : 'disconnected',
      latencyMs: tableLatency,
      detail: `${tablesOk}/${tablesTotal} tabel dapat diakses`,
    });

    // 4. Prisma direct connection check
    const prismaStart = performance.now();
    try {
      const { prisma } = await import('@/lib/supabase');
      await prisma.$queryRaw`SELECT 1`;
      const prismaLatency = Math.round(performance.now() - prismaStart);
      checks.push({
        name: 'Prisma Direct',
        status: prismaLatency > 3000 ? 'degraded' : 'connected',
        latencyMs: prismaLatency,
        detail: 'Koneksi langsung PostgreSQL OK',
      });
    } catch (err: any) {
      checks.push({
        name: 'Prisma Direct',
        status: 'disconnected',
        latencyMs: Math.round(performance.now() - prismaStart),
        detail: `Gagal: ${err.message?.slice(0, 60)}`,
      });
    }

    // Overall status
    const hasDisconnected = checks.some(c => c.status === 'disconnected');
    const hasDegraded = checks.some(c => c.status === 'degraded');
    const overall: 'connected' | 'degraded' | 'disconnected' = hasDisconnected ? 'disconnected' : hasDegraded ? 'degraded' : 'connected';

    // Average latency
    const avgLatency = checks.length > 0 ? Math.round(checks.reduce((s, c) => s + c.latencyMs, 0) / checks.length) : 0;

    return NextResponse.json({
      success: true,
      data: {
        overall,
        avgLatencyMs: avgLatency,
        checks,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('Supabase health error:', error);
    return NextResponse.json({
      success: true,
      data: {
        overall: 'disconnected' as const,
        avgLatencyMs: 0,
        checks: [{
          name: 'General',
          status: 'disconnected' as const,
          latencyMs: 0,
          detail: `Error: ${error.message?.slice(0, 60)}`,
        }],
        timestamp: new Date().toISOString(),
      },
    });
  }
}
