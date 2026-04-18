import { NextRequest, NextResponse } from 'next/server';
import os from 'os';
import { verifyAndGetAuthUser } from '@/lib/token';
import { db, prisma } from '@/lib/supabase';

/**
 * GET /api/monitoring
 * Returns system resource usage and Supabase table stats.
 * Only accessible by super_admin.
 */
export async function GET(request: NextRequest) {
  try {
    // Verify super_admin auth
    const result = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!result) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (result.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden — hanya super admin' }, { status: 403 });
    }

    // ===== SYSTEM RESOURCES =====
    const cpus = os.cpus();
    const cpuCount = cpus.length;

    // Calculate CPU usage average across all cores
    // Each core has times: user, nice, sys, idle, irq
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += (cpu.times as Record<string, number>)[type];
      }
      totalIdle += cpu.times.idle;
    }
    const cpuUsagePercent = totalTick > 0 ? Math.round(((totalTick - totalIdle) / totalTick) * 100) : 0;

    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    const usedMemoryBytes = totalMemoryBytes - freeMemoryBytes;
    const totalMemoryMB = Math.round(totalMemoryBytes / (1024 * 1024));
    const usedMemoryMB = Math.round(usedMemoryBytes / (1024 * 1024));
    const freeMemoryMB = Math.round(freeMemoryBytes / (1024 * 1024));
    const ramUsagePercent = Math.round((usedMemoryBytes / totalMemoryBytes) * 100);

    // System uptime
    const uptimeSeconds = os.uptime();
    const uptimeDays = Math.floor(uptimeSeconds / 86400);
    const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
    const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

    // ===== SUPABASE TABLE STATS =====
    const monitoredTables = [
      'events',
      'logs',
      'cashback_log',
      'push_subscriptions',
      'customer_follow_ups',
      'payment_proofs',
    ];

    // Get row counts via Supabase REST (PostgREST)
    const tableStatsPromises = monitoredTables.map(async (tableName) => {
      try {
        const { count } = await db
          .from(tableName)
          .select('id', { count: 'exact', head: true });
        return {
          table_name: tableName,
          row_count: count || 0,
        };
      } catch {
        return {
          table_name: tableName,
          row_count: -1, // Error indicator
        };
      }
    });

    // Get actual disk sizes via raw PostgreSQL query (using Prisma direct connection)
    let tableSizes: Array<{ table_name: string; estimated_size_mb: number }> = [];
    try {
      const sizeQuery = `
        SELECT relname as table_name,
               pg_total_relation_size(relid) as total_bytes
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
          AND relname IN (${monitoredTables.map((_, i) => `$${i + 1}`).join(', ')})
        ORDER BY pg_total_relation_size(relid) DESC;
      `;
      const sizeResults: Array<{ table_name: string; total_bytes: bigint }> =
        await prisma.$queryRawUnsafe(sizeQuery, ...monitoredTables);

      tableSizes = sizeResults.map((r) => ({
        table_name: r.table_name,
        estimated_size_mb: Math.round(Number(r.total_bytes) / (1024 * 1024) * 100) / 100,
      }));
    } catch (err) {
      console.warn('[Monitoring] Failed to query table sizes via raw SQL:', err);
      // Fallback: return zero sizes
      tableSizes = monitoredTables.map((t) => ({
        table_name: t,
        estimated_size_mb: 0,
      }));
    }

    // Merge row counts and sizes
    const rowCountMap = new Map<string, number>();
    const rowCountResults = await Promise.all(tableStatsPromises);
    for (const r of rowCountResults) {
      rowCountMap.set(r.table_name, r.row_count);
    }

    const sizeMap = new Map<string, number>();
    for (const s of tableSizes) {
      sizeMap.set(s.table_name, s.estimated_size_mb);
    }

    const tables = monitoredTables.map((name) => ({
      table_name: name,
      row_count: rowCountMap.get(name) ?? 0,
      estimated_size_mb: sizeMap.get(name) ?? 0,
    })).sort((a, b) => b.estimated_size_mb - a.estimated_size_mb);

    const totalRows = tables.reduce((sum, t) => sum + (t.row_count > 0 ? t.row_count : 0), 0);
    const totalSizeMB = tables.reduce((sum, t) => sum + t.estimated_size_mb, 0);

    return NextResponse.json({
      system: {
        cpu: {
          cores: cpuCount,
          usage_percent: cpuUsagePercent,
        },
        ram: {
          total_mb: totalMemoryMB,
          used_mb: usedMemoryMB,
          free_mb: freeMemoryMB,
          usage_percent: ramUsagePercent,
        },
        uptime: {
          days: uptimeDays,
          hours: uptimeHours,
          minutes: uptimeMinutes,
          total_seconds: uptimeSeconds,
        },
      },
      database: {
        tables,
        total_rows: totalRows,
        total_size_mb: Math.round(totalSizeMB * 100) / 100,
      },
    });
  } catch (error) {
    console.error('[Monitoring] Error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
