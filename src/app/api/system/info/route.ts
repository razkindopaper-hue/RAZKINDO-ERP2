// =====================================================================
// GET /api/system/info - System monitoring: CPU, RAM, Disk + Supabase storage
// =====================================================================
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';

function isDocker(): boolean {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    return cgroup.includes('docker') || cgroup.includes('lxc');
  } catch {
    return !!process.env.IS_DOCKER;
  }
}

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: user } = await db.from('users').select('role').eq('id', authUserId).single();
    if (!user || user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Akses ditolak' }, { status: 403 });
    }

    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const uptime = os.uptime();

    let cpuUsage = 0;
    try {
      let totalIdle = 0;
      let totalTick = 0;
      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += (cpu.times as any)[type];
        }
        totalIdle += cpu.times.idle;
      });
      cpuUsage = Math.round((1 - totalIdle / totalTick) * 100);
    } catch { cpuUsage = 0; }

    let loadAvg: number[] = [0, 0, 0];
    try { loadAvg = os.loadavg(); } catch { /* Windows */ }

    let diskInfo = { total: 0, used: 0, available: 0, usagePercent: 0 };
    try {
      const dfOutput = execSync("df -k / | tail -1", { encoding: 'utf-8' }).trim();
      const parts = dfOutput.split(/\s+/);
      if (parts.length >= 4) {
        const total = parseInt(parts[1]) * 1024;
        const used = parseInt(parts[2]) * 1024;
        const available = parseInt(parts[3]) * 1024;
        diskInfo = { total, used, available, usagePercent: Math.round((used / total) * 100) };
      }
    } catch { /* fallback */ }

    const tableDefs = [
      { name: 'transactions', label: 'Transaksi', safeToDelete: false, canCleanOld: true },
      { name: 'transaction_items', label: 'Item Transaksi', safeToDelete: false, canCleanOld: true },
      { name: 'payments', label: 'Pembayaran', safeToDelete: false, canCleanOld: true },
      { name: 'products', label: 'Produk', safeToDelete: false, canCleanOld: false },
      { name: 'customers', label: 'Pelanggan', safeToDelete: false, canCleanOld: false },
      { name: 'suppliers', label: 'Supplier', safeToDelete: false, canCleanOld: false },
      { name: 'users', label: 'Pengguna', safeToDelete: false, canCleanOld: false },
      { name: 'events', label: 'Event/Notifikasi', safeToDelete: true, canCleanOld: true },
      { name: 'logs', label: 'Log Aktivitas', safeToDelete: true, canCleanOld: true },
      { name: 'finance_requests', label: 'Request Keuangan', safeToDelete: false, canCleanOld: false },
      { name: 'fund_transfers', label: 'Transfer Dana', safeToDelete: false, canCleanOld: false },
      { name: 'bank_accounts', label: 'Rekening Bank', safeToDelete: false, canCleanOld: false },
      { name: 'cash_boxes', label: 'Kas Kecil', safeToDelete: false, canCleanOld: false },
      { name: 'salary_payments', label: 'Pembayaran Gaji', safeToDelete: false, canCleanOld: false },
      { name: 'company_debts', label: 'Hutang Perusahaan', safeToDelete: false, canCleanOld: false },
      { name: 'company_debt_payments', label: 'Pembayaran Hutang', safeToDelete: false, canCleanOld: false },
      { name: 'receivables', label: 'Piutang', safeToDelete: false, canCleanOld: false },
      { name: 'receivable_follow_ups', label: 'Follow Up Piutang', safeToDelete: false, canCleanOld: true },
      { name: 'customer_follow_ups', label: 'Follow Up Pelanggan', safeToDelete: false, canCleanOld: true },
      { name: 'sales_targets', label: 'Target Sales', safeToDelete: false, canCleanOld: false },
      { name: 'sales_tasks', label: 'Tugas Sales', safeToDelete: false, canCleanOld: false },
      { name: 'sales_task_reports', label: 'Laporan Tugas', safeToDelete: false, canCleanOld: true },
      { name: 'courier_cash', label: 'Kas Kurir', safeToDelete: false, canCleanOld: false },
      { name: 'courier_handovers', label: 'Setoran Kurir', safeToDelete: false, canCleanOld: false },
      { name: 'push_subscriptions', label: 'Push Subscription', safeToDelete: true, canCleanOld: true },
      { name: 'settings', label: 'Pengaturan', safeToDelete: false, canCleanOld: false },
      { name: 'cashback_config', label: 'Konfigurasi Cashback', safeToDelete: false, canCleanOld: false },
      { name: 'cashback_log', label: 'Log Cashback', safeToDelete: true, canCleanOld: true },
      { name: 'cashback_withdrawal', label: 'Penarikan Cashback', safeToDelete: false, canCleanOld: false },
      { name: 'customer_referral', label: 'Referral Pelanggan', safeToDelete: false, canCleanOld: false },
      { name: 'payment_proofs', label: 'Bukti Pembayaran', safeToDelete: false, canCleanOld: true },
      { name: 'unit_products', label: 'Stok Per Unit', safeToDelete: false, canCleanOld: false },
      { name: 'units', label: 'Unit/Cabang', safeToDelete: false, canCleanOld: false },
      { name: 'user_units', label: 'User-Unit', safeToDelete: false, canCleanOld: false },
      { name: 'custom_roles', label: 'Role Kustom', safeToDelete: false, canCleanOld: false },
      { name: 'password_resets', label: 'Reset Password', safeToDelete: true, canCleanOld: true },
    ];

    const tableData = [];
    let totalRows = 0;
    for (const table of tableDefs) {
      try {
        const { count, error } = await db.from(table.name).select('*', { count: 'exact', head: true });
        if (!error && count !== null) {
          totalRows += count;
          tableData.push({ ...table, rows: count });
        }
      } catch { /* skip */ }
    }

    return NextResponse.json({
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpuModel: cpus[0]?.model || 'Unknown',
        cpuCores: cpus.length,
        cpuUsage,
        loadAvg: loadAvg.map(v => Math.round(v * 100) / 100),
        totalMemory,
        usedMemory,
        freeMemory,
        memoryUsagePercent: Math.round((usedMemory / totalMemory) * 100),
        disk: diskInfo,
        uptime,
        isDocker: isDocker(),
      },
      supabase: { tables: tableData, totalRows },
    });
  } catch (error: any) {
    console.error('[System/Info] Error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
