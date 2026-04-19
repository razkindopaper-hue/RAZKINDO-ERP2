// =====================================================================
// GET /api/system/info - System resource monitoring
// =====================================================================
// Returns CPU, RAM, Disk usage and Database table row counts.
// Requires super_admin role.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';
import os from 'os';

// Tables that are safe to delete entirely (logs/events/cache)
const SAFE_DELETE_TABLES = [
  { name: 'events', label: 'Events (Log Aktivitas)', safeToDelete: true, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'audit_logs', label: 'Audit Logs', safeToDelete: true, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'notifications', label: 'Notifikasi', safeToDelete: true, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'push_subscriptions', label: 'Push Subscriptions', safeToDelete: true, canCleanOld: false, dateColumn: null },
  { name: 'login_logs', label: 'Login Logs', safeToDelete: true, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'password_reset_tokens', label: 'Reset Token', safeToDelete: true, canCleanOld: true, dateColumn: 'created_at' },
];

// Tables that can have old data cleaned but should NOT be fully deleted
const CLEAN_OLD_TABLES = [
  { name: 'transactions', label: 'Transaksi', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'transaction_items', label: 'Item Transaksi', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'customer_follow_ups', label: 'Follow Up Pelanggan', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'receivable_follow_ups', label: 'Follow Up Piutang', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'payments', label: 'Pembayaran', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'cashback_transactions', label: 'Transaksi Cashback', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'expense_items', label: 'Item Pengeluaran', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'sales_tasks', label: 'Tugas Sales', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
  { name: 'sales_task_history', label: 'Riwayat Tugas Sales', safeToDelete: false, canCleanOld: true, dateColumn: 'created_at' },
];

// Core tables that should NEVER be cleaned or deleted
const CORE_TABLES = [
  { name: 'users', label: 'Users' },
  { name: 'customers', label: 'Pelanggan' },
  { name: 'products', label: 'Produk' },
  { name: 'units', label: 'Unit/Cabang' },
  { name: 'categories', label: 'Kategori' },
  { name: 'settings', label: 'Pengaturan' },
  { name: 'roles', label: 'Roles' },
  { name: 'suppliers', label: 'Supplier' },
  { name: 'pool_dana', label: 'Pool Dana' },
  { name: 'sales_targets', label: 'Target Sales' },
  { name: 'finance_requests', label: 'Request Keuangan' },
  { name: 'receivables', label: 'Piutang' },
  { name: 'expenses', label: 'Pengeluaran' },
  { name: 'salaries', label: 'Gaji' },
];

function getCPUUsage(): number {
  const load1 = os.loadavg()[0];
  const cores = os.cpus().length;
  // loadavg is 1-min average, approximate CPU% = (load / cores) * 100
  return Math.min(100, Math.round((load1 / cores) * 100));
}

function getDiskInfo() {
  try {
    // Use df command on macOS/Linux
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process');
    const output = execSync('df -k / 2>/dev/null || df -k . 2>/dev/null').toString();
    const lines = output.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1]) * 1024; // KB to bytes
      const used = parseInt(parts[2]) * 1024;
      const available = parseInt(parts[3]) * 1024;
      return {
        total,
        used,
        available,
        usagePercent: Math.round((used / total) * 100),
      };
    }
  } catch {
    // Fallback: return zeros
  }
  return { total: 0, used: 0, available: 0, usagePercent: 0 };
}

async function getTableRowCount(tableName: string): Promise<number> {
  try {
    const { count, error } = await db
      .from(tableName)
      .select('*', { count: 'exact', head: true });

    if (error) return -1; // Table might not exist
    return count || 0;
  } catch {
    return -1;
  }
}

export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // System info
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || 'Unknown';
    const disk = getDiskInfo();

    const systemInfo = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuModel,
      cpuCores: cpus.length,
      cpuUsage: getCPUUsage(),
      loadAvg: os.loadavg(),
      totalMemory,
      usedMemory,
      freeMemory,
      memoryUsagePercent: Math.round((usedMemory / totalMemory) * 100),
      disk,
      uptime: os.uptime(),
      isDocker: !!process.env.DOCKER_CONTAINER || !!process.env.IS_DOCKER,
    };

    // Fetch Database table counts in parallel
    const allTableDefs = [
      ...SAFE_DELETE_TABLES.map(t => ({ ...t, safeToDelete: true, canCleanOld: true })),
      ...CLEAN_OLD_TABLES.map(t => ({ ...t, safeToDelete: false, canCleanOld: true })),
      ...CORE_TABLES.map(t => ({ ...t, safeToDelete: false, canCleanOld: false })),
    ];

    const tableResults = await Promise.all(
      allTableDefs.map(async (t) => ({
        name: t.name,
        label: t.label,
        rows: await getTableRowCount(t.name),
        safeToDelete: t.safeToDelete || false,
        canCleanOld: t.canCleanOld || false,
      }))
    );

    // Filter out tables that don't exist (rows === -1)
    const existingTables = tableResults.filter(t => t.rows >= 0);
    const totalRows = existingTables.reduce((sum, t) => sum + t.rows, 0);

    return NextResponse.json({
      system: systemInfo,
      database: {
        tables: existingTables,
        totalRows,
      },
    });
  } catch (err: any) {
    console.error('[System/Info] Error:', err);
    return NextResponse.json({ error: err.message || 'Gagal memuat info sistem' }, { status: 500 });
  }
}
