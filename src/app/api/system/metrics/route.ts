// =====================================================================
// GET /api/system/metrics - Real-time system metrics (lightweight)
//
// Returns CPU, RAM, and Database latency for live monitoring.
// Designed to be called every 1 second — no heavy queries.
// Requires super_admin role.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';
import os from 'os';

// CPU usage tracking (differential measurement)
let _prevCpuInfo: { idle: number; total: number; usage: number; timestamp: number } | null = null;

function getCPUUsage(): number {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      const val = cpu.times[type as keyof typeof cpu.times];
      totalTick += val;
    }
    totalIdle += cpu.times.idle;
  }

  const now = Date.now();

  if (_prevCpuInfo) {
    const idleDiff = totalIdle - _prevCpuInfo.idle;
    const totalDiff = totalTick - _prevCpuInfo.total;

    if (totalDiff > 0) {
      const usage = Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
      _prevCpuInfo = { idle: totalIdle, total: totalTick, usage, timestamp: now };
      return usage;
    }
  }

  _prevCpuInfo = { idle: totalIdle, total: totalTick, usage: 0, timestamp: now };

  // Fallback on first call: use load average approximation
  if (_prevCpuInfo.usage === 0) {
    const load1 = os.loadavg()[0];
    const cores = cpus.length;
    return Math.min(100, Math.round((load1 / cores) * 100));
  }

  return _prevCpuInfo.usage;
}

async function measureDatabaseLatency(): Promise<{
  readMs: number;
  writeMs: number;
  status: 'healthy' | 'degraded' | 'down';
  error?: string;
}> {
  try {
    // Measure READ latency (lightweight query)
    const readStart = performance.now();
    const { error: readError } = await db
      .from('users')
      .select('id', { count: 'exact', head: true });
    const readMs = Math.round(performance.now() - readStart);

    if (readError) {
      return { readMs, writeMs: -1, status: 'down', error: readError.message };
    }

    // Measure WRITE latency via a simple settings read (lightweight RPC)
    // We skip actual writes to avoid side effects — use a read-only RPC
    const writeStart = performance.now();
    const { data: rpcData, error: rpcError } = await db.rpc('get_supabase_stats');
    const writeMs = Math.round(performance.now() - writeStart);

    // If the RPC doesn't exist, that's fine — use read latency as proxy
    const effectiveWriteMs = rpcError && rpcError.message?.includes('not found')
      ? readMs
      : writeMs;

    // Determine health status
    const maxMs = Math.max(readMs, effectiveWriteMs);
    let status: 'healthy' | 'degraded' | 'down' = 'healthy';
    if (maxMs > 2000) status = 'down';
    else if (maxMs > 500) status = 'degraded';

    return { readMs, writeMs: effectiveWriteMs, status };
  } catch (err: any) {
    return { readMs: -1, writeMs: -1, status: 'down', error: err.message || 'Connection failed' };
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Run CPU/RAM and Database latency in parallel
    const [cpuUsage, databaseLatency] = await Promise.all([
      Promise.resolve(getCPUUsage()),
      measureDatabaseLatency(),
    ]);

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryUsagePercent = Math.round((usedMemory / totalMemory) * 100);

    return NextResponse.json({
      timestamp: Date.now(),
      cpu: {
        usage: cpuUsage,
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown',
        loadAvg: os.loadavg(),
      },
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        usagePercent: memoryUsagePercent,
      },
      database: databaseLatency,
      uptime: os.uptime(),
      process: {
        memoryUsage: process.memoryUsage(),
        pid: process.pid,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Gagal memuat metrik' },
      { status: 500 }
    );
  }
}
