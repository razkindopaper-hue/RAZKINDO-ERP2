// =====================================================================
// HEALTH CHECK ENDPOINT
// GET /api/health
//
// Returns a lightweight system health report.
// Heavy operations (connection pool stats, performance metrics) are
// skipped unless ?verbose=1 is passed to reduce memory/CPU on every poll.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { CircuitBreaker } from '@/lib/circuit-breaker';
import { getDegradationLevel, featureFlags } from '@/lib/graceful-degradation';
import { memoryGuard } from '@/lib/memory-guard';

type CheckStatus = 'ok' | 'warning' | 'error';
type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

interface HealthResponse {
  status: OverallStatus;
  timestamp: string;
  uptime: number;
  degradation: {
    level: 'full' | 'partial' | 'minimal';
    disabledFeatures: string[];
  };
  checks: {
    database: { status: CheckStatus; latency_ms: number };
    memory: {
      status: CheckStatus;
      used_mb: number;
      total_mb: number;
      percent: number;
      underPressure: boolean;
    };
    circuitBreakers?: { name: string; state: string; failures: number }[];
    connectionPool?: {
      transaction: { active: number; idle: number; waiting: number; healthy: boolean };
      session: { active: number; idle: number; waiting: number; healthy: boolean };
    };
    performance?: {
      summary: {
        healthy: boolean;
        issues: number;
        message: string;
      };
      activeAlerts: number;
    };
  };
}

export async function GET(request: NextRequest) {
  const timestamp = new Date().toISOString();
  const uptime = Math.floor(process.uptime());
  const verbose = request.nextUrl.searchParams.get('verbose') === '1';

  // Core checks (always run)
  const [dbCheck, memoryCheck] = await Promise.all([
    checkDatabase(),
    checkMemory(),
  ]);

  // Determine overall status
  let status: OverallStatus = 'healthy';

  if (dbCheck.status === 'error') {
    status = 'unhealthy';
  } else if (memoryCheck.status === 'warning') {
    status = 'degraded';
  }

  // Graceful degradation info
  const degradationLevel = getDegradationLevel();
  const disabledFeatures = featureFlags.getDisabledFeatures();

  const body: HealthResponse = {
    status,
    timestamp,
    uptime,
    degradation: {
      level: degradationLevel,
      disabledFeatures,
    },
    checks: {
      database: dbCheck,
      memory: memoryCheck,
    },
  };

  // Heavy checks only in verbose mode
  if (verbose) {
    const [cbCheck, poolCheck, perfCheck] = await Promise.all([
      checkCircuitBreakers(),
      checkConnectionPool(),
      checkPerformance(),
    ]);

    if (cbCheck.some((cb) => cb.state === 'open')) {
      status = 'degraded';
      body.status = status;
    }
    if (perfCheck && !perfCheck.summary.healthy) {
      status = 'degraded';
      body.status = status;
    }

    body.checks.circuitBreakers = cbCheck;
    body.checks.connectionPool = poolCheck;
    body.checks.performance = perfCheck;
  }

  const httpStatus = status === 'unhealthy' ? 503 : 200;

  return NextResponse.json(body, { status: httpStatus });
}

// -------------------------------------------------------------------
// Individual check functions
// -------------------------------------------------------------------

interface DatabaseCheck {
  status: 'ok' | 'error';
  latency_ms: number;
}

async function checkDatabase(): Promise<DatabaseCheck> {
  const start = performance.now();
  try {
    await db.from('settings').select('key').limit(1);
    const latency_ms = Math.round(performance.now() - start);
    return { status: 'ok', latency_ms };
  } catch {
    const latency_ms = Math.round(performance.now() - start);
    return { status: 'error', latency_ms };
  }
}

interface MemoryCheck {
  status: 'ok' | 'warning';
  used_mb: number;
  total_mb: number;
  percent: number;
  underPressure: boolean;
}

function checkMemory(): MemoryCheck {
  const stats = memoryGuard.getStats();
  // V8 naturally fills heap to 85-95% — only warn if actually under pressure (leak detected)
  // or if RSS is dangerously high (>1500MB suggests imminent OOM kill)
  const isWarning = stats.underPressure || stats.rss > 1500;
  return {
    status: isWarning ? 'warning' : 'ok',
    used_mb: stats.used,
    total_mb: stats.total,
    percent: stats.percent,
    underPressure: memoryGuard.isUnderPressure(),
  };
}

function checkCircuitBreakers(): { name: string; state: string; failures: number }[] {
  return CircuitBreaker.getAllStats();
}

async function checkConnectionPool() {
  try {
    const { getPoolStats } = await import('@/lib/connection-pool');
    const stats = await getPoolStats();
    return {
      transaction: {
        active: stats.transaction.activeConnections,
        idle: stats.transaction.idleConnections,
        waiting: stats.transaction.waitingRequests,
        healthy: stats.transaction.isHealthy,
      },
      session: {
        active: stats.session.activeConnections,
        idle: stats.session.idleConnections,
        waiting: stats.session.waitingRequests,
        healthy: stats.session.isHealthy,
      },
    };
  } catch {
    return {
      transaction: { active: 0, idle: 0, waiting: 0, healthy: false },
      session: { active: 0, idle: 0, waiting: 0, healthy: false },
    };
  }
}

async function checkPerformance() {
  try {
    const { perfMonitor } = await import('@/lib/performance-monitor');
    const metrics = perfMonitor.getMetrics();
    return {
      summary: {
        healthy: metrics.summary.healthy,
        issues: metrics.summary.issues,
        message: metrics.summary.message,
      },
      activeAlerts: metrics.activeAlerts.length,
    };
  } catch {
    return {
      summary: { healthy: true, issues: 0, message: 'Performance monitor unavailable' },
      activeAlerts: 0,
    };
  }
}
