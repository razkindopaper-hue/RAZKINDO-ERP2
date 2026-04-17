import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { enforceSuperAdmin } from '@/lib/require-auth';
import { db } from '@/lib/supabase';
import { existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

interface RepairResult {
  check: string;
  status: 'passed' | 'fixed' | 'failed' | 'skipped';
  message: string;
  details?: any;
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return NextResponse.json({ success: false, error: 'Akses ditolak' }, { status: authResult.response.status === 401 ? 401 : 403 });

    const results: RepairResult[] = [];

    // 1. Clean /tmp/tectonic (LaTeX cache - auto recreated)
    try {
      const tectonicPath = '/tmp/tectonic';
      if (existsSync(tectonicPath)) {
        const beforeSize = getDirSize(tectonicPath);
        rmSync(tectonicPath, { recursive: true, force: true });
        results.push({ check: 'Tectonic Cache (/tmp/tectonic)', status: 'fixed', message: `Dihapus ${formatBytes(beforeSize)} cache LaTeX`, details: { freed: beforeSize } });
      } else {
        results.push({ check: 'Tectonic Cache (/tmp/tectonic)', status: 'passed', message: 'Tidak ada cache tectonic' });
      }
    } catch (err: any) {
      results.push({ check: 'Tectonic Cache (/tmp/tectonic)', status: 'failed', message: `Gagal hapus: ${err.message}` });
    }

    // 2. Clean /tmp/HEAD.tar (Git archive temp)
    try {
      const headTar = '/tmp/HEAD.tar';
      if (existsSync(headTar)) {
        const size = statSync(headTar).size;
        rmSync(headTar, { force: true });
        results.push({ check: 'Git Archive Temp (/tmp/HEAD.tar)', status: 'fixed', message: `Dihapus ${formatBytes(size)} file archive sementara`, details: { freed: size } });
      } else {
        results.push({ check: 'Git Archive Temp (/tmp/HEAD.tar)', status: 'passed', message: 'Tidak ada file archive sementara' });
      }
    } catch (err: any) {
      results.push({ check: 'Git Archive Temp (/tmp/HEAD.tar)', status: 'failed', message: `Gagal hapus: ${err.message}` });
    }

    // 3. Clean /tmp/razkindo-archive
    try {
      const archivePath = '/tmp/razkindo-archive';
      if (existsSync(archivePath)) {
        const beforeSize = getDirSize(archivePath);
        rmSync(archivePath, { recursive: true, force: true });
        results.push({ check: 'Razkindo Archive (/tmp/razkindo-archive)', status: 'fixed', message: `Dihapus ${formatBytes(beforeSize)} archive sementara`, details: { freed: beforeSize } });
      } else {
        results.push({ check: 'Razkindo Archive (/tmp/razkindo-archive)', status: 'passed', message: 'Tidak ada archive sementara' });
      }
    } catch (err: any) {
      results.push({ check: 'Razkindo Archive (/tmp/razkindo-archive)', status: 'failed', message: `Gagal hapus: ${err.message}` });
    }

    // 4. Clean /tmp/my-project (old project temp)
    try {
      const tmpProject = '/tmp/my-project';
      if (existsSync(tmpProject)) {
        const beforeSize = getDirSize(tmpProject);
        rmSync(tmpProject, { recursive: true, force: true });
        results.push({ check: 'Old Project Temp (/tmp/my-project)', status: 'fixed', message: `Dihapus ${formatBytes(beforeSize)} project sementara lama`, details: { freed: beforeSize } });
      } else {
        results.push({ check: 'Old Project Temp (/tmp/my-project)', status: 'passed', message: 'Tidak ada project sementara lama' });
      }
    } catch (err: any) {
      results.push({ check: 'Old Project Temp (/tmp/my-project)', status: 'failed', message: `Gagal hapus: ${err.message}` });
    }

    // 5. Clean Next.js .next/cache
    try {
      const nextCache = join(process.cwd(), '.next', 'cache');
      if (existsSync(nextCache)) {
        const beforeSize = getDirSize(nextCache);
        rmSync(nextCache, { recursive: true, force: true });
        results.push({ check: 'Next.js Cache (.next/cache)', status: 'fixed', message: `Dihapus ${formatBytes(beforeSize)} cache Next.js (akan dibuat ulang otomatis)`, details: { freed: beforeSize } });
      } else {
        results.push({ check: 'Next.js Cache (.next/cache)', status: 'passed', message: 'Tidak ada cache Next.js' });
      }
    } catch (err: any) {
      results.push({ check: 'Next.js Cache (.next/cache)', status: 'failed', message: `Gagal hapus: ${err.message}` });
    }

    // 6. Clean node_modules/.cache
    try {
      const nodeCache = join(process.cwd(), 'node_modules', '.cache');
      if (existsSync(nodeCache)) {
        const beforeSize = getDirSize(nodeCache);
        rmSync(nodeCache, { recursive: true, force: true });
        results.push({ check: 'Node Modules Cache (node_modules/.cache)', status: 'fixed', message: `Dihapus ${formatBytes(beforeSize)} cache node modules`, details: { freed: beforeSize } });
      } else {
        results.push({ check: 'Node Modules Cache (node_modules/.cache)', status: 'passed', message: 'Tidak ada cache node modules' });
      }
    } catch (err: any) {
      results.push({ check: 'Node Modules Cache (node_modules/.cache)', status: 'failed', message: `Gagal hapus: ${err.message}` });
    }

    // 7. Clean old logs in Supabase (>30 days)
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: oldLogs, error: fetchErr } = await db.from('logs').select('id').lt('created_at', thirtyDaysAgo);
      if (fetchErr) {
        results.push({ check: 'Log Lama Supabase (>30 hari)', status: 'failed', message: `Query error: ${fetchErr.message}` });
      } else if (oldLogs && oldLogs.length > 0) {
        const { error: delErr } = await db.from('logs').delete().lt('created_at', thirtyDaysAgo);
        if (delErr) {
          results.push({ check: 'Log Lama Supabase (>30 hari)', status: 'failed', message: `Delete error: ${delErr.message}` });
        } else {
          results.push({ check: 'Log Lama Supabase (>30 hari)', status: 'fixed', message: `Dihapus ${oldLogs.length} log lama`, details: { count: oldLogs.length } });
        }
      } else {
        results.push({ check: 'Log Lama Supabase (>30 hari)', status: 'passed', message: 'Tidak ada log lama' });
      }
    } catch (err: any) {
      results.push({ check: 'Log Lama Supabase (>30 hari)', status: 'failed', message: `Error: ${err.message}` });
    }

    // 8. Clean old read notifications (>7 days)
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      // Try is_read first, then read as fallback
      let col = 'is_read';
      const { data: testRead, error: testErr } = await db.from('events').select('id').eq('is_read', true).limit(1);
      if (testErr) {
        // Try 'read' column
        const { data: testRead2, error: testErr2 } = await db.from('events').select('id').eq('read', true).limit(1);
        if (!testErr2) col = 'read';
      }

      const { data: oldEvents, error: fetchErr } = await db.from('events').select('id').eq(col, true).lt('created_at', sevenDaysAgo);
      if (fetchErr) {
        results.push({ check: 'Notifikasi Lama (>7 hari)', status: 'failed', message: `Query error: ${fetchErr.message}` });
      } else if (oldEvents && oldEvents.length > 0) {
        const { error: delErr } = await db.from('events').delete().eq(col, true).lt('created_at', sevenDaysAgo);
        if (delErr) {
          results.push({ check: 'Notifikasi Lama (>7 hari)', status: 'failed', message: `Delete error: ${delErr.message}` });
        } else {
          results.push({ check: 'Notifikasi Lama (>7 hari)', status: 'fixed', message: `Dihapus ${oldEvents.length} notifikasi lama`, details: { count: oldEvents.length } });
        }
      } else {
        results.push({ check: 'Notifikasi Lama (>7 hari)', status: 'passed', message: 'Tidak ada notifikasi lama' });
      }
    } catch (err: any) {
      results.push({ check: 'Notifikasi Lama (>7 hari)', status: 'failed', message: `Error: ${err.message}` });
    }

    // 9. Clean rejected finance requests (safe to delete)
    try {
      const { data: rejectedFR, error: fetchErr } = await db.from('finance_requests').select('id').eq('status', 'rejected');
      if (fetchErr) {
        results.push({ check: 'Request Keuangan Ditolak', status: 'failed', message: `Query error: ${fetchErr.message}` });
      } else if (rejectedFR && rejectedFR.length > 0) {
        // Exclude any linked to salary_payments
        const { data: linkedSalary } = await db.from('salary_payments').select('finance_request_id').not('finance_request_id', 'is', null);
        const excludeIds = (linkedSalary || []).map((r: any) => r.finance_request_id);
        let deleteQuery = db.from('finance_requests').delete().eq('status', 'rejected');
        if (excludeIds.length > 0) {
          deleteQuery = deleteQuery.not('id', 'in', excludeIds);
        }
        const { error: delErr } = await deleteQuery;
        if (delErr) {
          results.push({ check: 'Request Keuangan Ditolak', status: 'failed', message: `Delete error: ${delErr.message}` });
        } else {
          results.push({ check: 'Request Keuangan Ditolak', status: 'fixed', message: `Dihapus ${rejectedFR.length} request yang ditolak`, details: { count: rejectedFR.length } });
        }
      } else {
        results.push({ check: 'Request Keuangan Ditolak', status: 'passed', message: 'Tidak ada request yang ditolak' });
      }
    } catch (err: any) {
      results.push({ check: 'Request Keuangan Ditolak', status: 'failed', message: `Error: ${err.message}` });
    }

    // 10. Clean rejected salary payments
    try {
      const { data: rejectedSalary, error: fetchErr } = await db.from('salary_payments').select('id').eq('status', 'rejected');
      if (fetchErr) {
        results.push({ check: 'Pembayaran Gaji Ditolak', status: 'failed', message: `Query error: ${fetchErr.message}` });
      } else if (rejectedSalary && rejectedSalary.length > 0) {
        await db.from('salary_payments').update({ finance_request_id: null }).eq('status', 'rejected');
        const { error: delErr } = await db.from('salary_payments').delete().eq('status', 'rejected');
        if (delErr) {
          results.push({ check: 'Pembayaran Gaji Ditolak', status: 'failed', message: `Delete error: ${delErr.message}` });
        } else {
          results.push({ check: 'Pembayaran Gaji Ditolak', status: 'fixed', message: `Dihapus ${rejectedSalary.length} pembayaran gaji yang ditolak`, details: { count: rejectedSalary.length } });
        }
      } else {
        results.push({ check: 'Pembayaran Gaji Ditolak', status: 'passed', message: 'Tidak ada pembayaran gaji yang ditolak' });
      }
    } catch (err: any) {
      results.push({ check: 'Pembayaran Gaji Ditolak', status: 'failed', message: `Error: ${err.message}` });
    }

    // 11. Clean cancelled and bad_debt receivables
    try {
      const { data: cancelledRec } = await db.from('receivables').select('id').eq('status', 'cancelled');
      const { data: badDebtRec } = await db.from('receivables').select('id').eq('status', 'bad_debt');
      const toDelete = [...(cancelledRec || []), ...(badDebtRec || [])];

      if (toDelete.length > 0) {
        const ids = toDelete.map((r: any) => r.id);
        // Delete follow-ups first
        await db.from('receivable_follow_ups').delete().in('receivable_id', ids);
        // Delete the receivables
        const { error: delErr } = await db.from('receivables').delete().in('id', ids);
        if (delErr) {
          results.push({ check: 'Piutang Dibatalkan/Macet', status: 'failed', message: `Delete error: ${delErr.message}` });
        } else {
          results.push({ check: 'Piutang Dibatalkan/Macet', status: 'fixed', message: `Dihapus ${toDelete.length} piutang (dibatalkan: ${cancelledRec?.length || 0}, macet: ${badDebtRec?.length || 0})`, details: { count: toDelete.length } });
        }
      } else {
        results.push({ check: 'Piutang Dibatalkan/Macet', status: 'passed', message: 'Tidak ada piutang yang perlu dihapus' });
      }
    } catch (err: any) {
      results.push({ check: 'Piutang Dibatalkan/Macet', status: 'failed', message: `Error: ${err.message}` });
    }

    // 12. Verify Supabase connection
    try {
      const { error: connErr } = await db.from('users').select('id').limit(1);
      if (connErr) {
        results.push({ check: 'Koneksi Supabase', status: 'failed', message: `Supabase error: ${connErr.message}` });
      } else {
        results.push({ check: 'Koneksi Supabase', status: 'passed', message: 'Koneksi database normal' });
      }
    } catch (err: any) {
      results.push({ check: 'Koneksi Supabase', status: 'failed', message: `Error: ${err.message}` });
    }

    // 13. Check disk space
    try {
      const dfOutput = execSync("df -B1 / | tail -1", { encoding: 'utf-8' });
      const parts = dfOutput.trim().split(/\s+/);
      if (parts.length >= 5) {
        const usedPercent = parseInt(parts[4]) || 0;
        if (usedPercent > 90) {
          results.push({ check: 'Disk Space', status: 'failed', message: `Disk sangat penuh: ${usedPercent}% terpakai` });
        } else if (usedPercent > 75) {
          results.push({ check: 'Disk Space', status: 'fixed', message: `Disk mulai penuh: ${usedPercent}% terpakai (sudah dibersihkan di atas)`, details: { percent: usedPercent } });
        } else {
          results.push({ check: 'Disk Space', status: 'passed', message: `Disk OK: ${usedPercent}% terpakai` });
        }
      }
    } catch (err: any) {
      results.push({ check: 'Disk Space', status: 'skipped', message: 'Tidak dapat membaca info disk' });
    }

    // 14. Check memory usage
    try {
      const memOutput = execSync("free -b | grep Mem", { encoding: 'utf-8' });
      const memParts = memOutput.trim().split(/\s+/);
      const total = parseInt(memParts[1]) || 1;
      const available = parseInt(memParts[6]) || 0;
      const usedPercent = Math.round(((total - available) / total) * 100);
      if (usedPercent > 90) {
        results.push({ check: 'RAM Usage', status: 'failed', message: `RAM sangat penuh: ${usedPercent}% terpakai` });
      } else if (usedPercent > 75) {
        results.push({ check: 'RAM Usage', status: 'fixed', message: `RAM tinggi: ${usedPercent}% terpakai (cache dibersihkan)`, details: { percent: usedPercent } });
      } else {
        results.push({ check: 'RAM Usage', status: 'passed', message: `RAM OK: ${usedPercent}% terpakai` });
      }
    } catch (err: any) {
      results.push({ check: 'RAM Usage', status: 'skipped', message: 'Tidak dapat membaca info RAM' });
    }

    // Summary
    const passed = results.filter(r => r.status === 'passed').length;
    const fixed = results.filter(r => r.status === 'fixed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const totalFreed = results.reduce((sum, r) => sum + (r.details?.freed || 0), 0);

    const message = fixed > 0
      ? `Selesai! ${fixed} masalah diperbaiki, ${passed} OK, ${failed} gagal. Ruang dibebaskan: ${formatBytes(totalFreed)}`
      : `Semua cek OK! ${passed} pemeriksaan lulus, ${failed} gagal.`;

    return NextResponse.json({
      success: true,
      results,
      summary: { total: results.length, passed, fixed, failed, totalFreed, totalFreedFormatted: formatBytes(totalFreed) },
      message,
    });
  } catch (error: any) {
    console.error('Auto-repair error:', error);
    return NextResponse.json({ success: false, error: 'Gagal menjalankan auto-repair: ' + error.message }, { status: 500 });
  }
}

// Helpers
function getDirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let totalSize = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += getDirSize(fullPath);
      } else {
        try { totalSize += statSync(fullPath).size; } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return totalSize;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
