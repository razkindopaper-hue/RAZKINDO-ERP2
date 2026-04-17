import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { enforceSuperAdmin } from '@/lib/require-auth';
import { readdir, stat } from 'fs/promises';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// ---- Server-side cache with TTL ----
interface CacheEntry<T> { data: T; timestamp: number; }
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string, ttlMs: number): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < ttlMs) return entry.data as T;
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ---- Async directory size (non-blocking) ----
async function getDirectorySizeAsync(dirPath: string, skipDirs: string[] = ['node_modules', '.next']): Promise<number> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.includes(entry.name)) return 0;
          return getDirectorySizeAsync(fullPath, skipDirs);
        }
        try { return (await stat(fullPath)).size; } catch { return 0; }
      })
    );
    return sizes.reduce((sum, s) => sum + s, 0);
  } catch { return 0; }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ---- Parallel table count query ----
async function getTableCountsParallel(tables: string[]): Promise<Record<string, number>> {
  const results = await Promise.all(
    tables.map(async (table) => {
      try {
        const { count } = await db.from(table).select('*', { count: 'exact', head: true });
        return [table, count || 0] as const;
      } catch {
        return [table, 0] as const;
      }
    })
  );
  return Object.fromEntries(results);
}

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    // Check cache first (5 minute TTL for storage overview)
    const cacheKey = `storage-overview-${authUserId}`;
    const cached = getCached<Record<string, unknown>>(cacheKey, 300_000);
    if (cached) return NextResponse.json({ success: true, data: cached, fromCache: true });

    const projectRoot = process.cwd();

    // Run disk info, directory sizes, and DB queries IN PARALLEL
    const [diskInfo, dirSizes, tableCounts, cleanableData] = await Promise.all([
      // 1. Disk info (fast execSync)
      (async () => {
        try {
          const dfOutput = execSync("df -B1 / | tail -1", { encoding: 'utf-8', timeout: 3000 });
          const parts = dfOutput.trim().split(/\s+/);
          if (parts.length >= 5) {
            const totalBytes = parseInt(parts[1]) || 0;
            const usedBytes = parseInt(parts[2]) || 0;
            const availableBytes = parseInt(parts[3]) || 0;
            return {
              total: totalBytes, used: usedBytes, available: availableBytes,
              totalFormatted: formatBytes(totalBytes), usedFormatted: formatBytes(usedBytes), availableFormatted: formatBytes(availableBytes),
              percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
            };
          }
          return null;
        } catch { return null; }
      })(),

      // 2. Directory sizes (async, parallel)
      (async () => {
        const directories = [
          { name: 'Source Code (src)', path: join(projectRoot, 'src') },
          { name: 'Build Cache (.next)', path: join(projectRoot, '.next') },
          { name: 'Dependencies (node_modules)', path: join(projectRoot, 'node_modules') },
          { name: 'Mini Services', path: join(projectRoot, 'mini-services') },
          { name: 'Public Assets', path: join(projectRoot, 'public') },
        ];
        const sizes = await Promise.all(
          directories.map(async (dir) => {
            const size = await getDirectorySizeAsync(dir.path);
            return { name: dir.name, size, formatted: formatBytes(size) };
          })
        );
        sizes.sort((a, b) => b.size - a.size);
        return { totalSize: sizes.reduce((s, d) => s + d.size, 0), directories: sizes };
      })(),

      // 3. Table row counts (parallel)
      getTableCountsParallel([
        'users', 'units', 'products', 'unit_products', 'customers', 'suppliers',
        'transactions', 'transaction_items', 'payments', 'salary_payments',
        'bank_accounts', 'cash_boxes', 'finance_requests', 'fund_transfers',
        'company_debts', 'company_debt_payments', 'receivables', 'receivable_follow_ups',
        'sales_targets', 'courier_cash', 'courier_handovers', 'logs', 'events', 'settings',
      ]),

      // 4. Cleanable counts (parallel — both temp files and DB records)
      (async () => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const [
          tmpTectonic, tmpHeadTar, tmpArchive, tmpProject, nextCache, nodeCache,
          oldLogs, oldReadEvents, totalReadEvents, rejectedFR, rejectedSalary,
          cancelledRec, badDebtRec, totalLogs,
        ] = await Promise.all([
          // Temp file sizes (async)
          getDirectorySizeAsync('/tmp/tectonic', []),
          (async () => { try { return existsSync('/tmp/HEAD.tar') ? (await stat('/tmp/HEAD.tar')).size : 0; } catch { return 0; } })(),
          getDirectorySizeAsync('/tmp/razkindo-archive', []),
          getDirectorySizeAsync('/tmp/my-project', []),
          getDirectorySizeAsync(join(projectRoot, '.next', 'cache'), []),
          getDirectorySizeAsync(join(projectRoot, 'node_modules', '.cache'), []),
          // DB cleanable counts (parallel)
          db.from('logs').select('*', { count: 'exact', head: true }).lt('created_at', thirtyDaysAgo),
          db.from('events').select('*', { count: 'exact', head: true }).eq('is_read', true).lt('created_at', sevenDaysAgo),
          db.from('events').select('*', { count: 'exact', head: true }).eq('is_read', true),
          db.from('finance_requests').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
          db.from('salary_payments').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
          db.from('receivables').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
          db.from('receivables').select('*', { count: 'exact', head: true }).eq('status', 'bad_debt'),
          db.from('logs').select('*', { count: 'exact', head: true }),
        ]);

        return {
          tmp_tectonic: tmpTectonic,
          tmp_head_tar: tmpHeadTar,
          tmp_razkindo_archive: tmpArchive,
          tmp_my_project: tmpProject,
          next_cache: nextCache,
          node_modules_cache: nodeCache,
          old_logs_30d: oldLogs.count || 0,
          old_read_events_7d: oldReadEvents.count || 0,
          total_read_events: totalReadEvents.count || 0,
          rejected_finance_requests: rejectedFR.count || 0,
          rejected_salary_payments: rejectedSalary.count || 0,
          cancelled_receivables: cancelledRec.count || 0,
          bad_debt_receivables: badDebtRec.count || 0,
          total_logs: totalLogs.count || 0,
        };
      })(),
    ]);

    // Database metadata
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseDbUrl = process.env.SUPABASE_DB_URL || '';
    let dbHost = '';
    let dbRegion = 'ap-southeast-1';
    if (supabaseDbUrl) {
      try {
        const urlMatch = supabaseDbUrl.match(/@([^.]+)\.([^.]+)\./);
        if (urlMatch) {
          dbHost = `${urlMatch[1]}.${urlMatch[2]}.supabase.co`;
          dbRegion = urlMatch[2].replace('pooler.', '').replace('aws-1-', '');
        }
      } catch { /* keep defaults */ }
    }

    const projectTotal = dirSizes.totalSize;
    const result = {
      disk: diskInfo,
      project: { totalSize: projectTotal, totalFormatted: formatBytes(projectTotal), directories: dirSizes.directories },
      database: { type: 'Supabase (PostgreSQL)', host: dbHost, region: dbRegion, dbName: 'postgres', totalTables: Object.keys(tableCounts).length, tableCounts },
      cleanable: cleanableData,
    };

    // Cache the result
    setCache(cacheKey, result);

    return NextResponse.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Storage API error:', message);
    return NextResponse.json({ success: false, error: 'Gagal mengambil info storage' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return NextResponse.json({ success: false, error: 'Akses ditolak' }, { status: authResult.response.status === 401 ? 401 : 403 });

    const body = await request.json();
    const { action, targets } = body;

    if (action === 'cleanup') {
      if (!targets || !Array.isArray(targets) || targets.length === 0) return NextResponse.json({ success: false, error: 'Pilih data yang ingin dibersihkan' }, { status: 400 });

      const results: Record<string, number> = {};
      for (const target of targets) {
        try {
          let count = 0;
          // Server temp file cleanup (sync is OK for delete operations)
          if (target === 'tmp_tectonic') {
            const p = '/tmp/tectonic';
            if (existsSync(p)) { try { const s = await getDirectorySizeAsync(p, []); rmSync(p, { recursive: true, force: true }); count = s; } catch { count = -1; } }
          } else if (target === 'tmp_head_tar') {
            const p = '/tmp/HEAD.tar';
            if (existsSync(p)) { try { const s = (await stat(p)).size; rmSync(p, { force: true }); count = s; } catch { count = -1; } }
          } else if (target === 'tmp_razkindo_archive') {
            const p = '/tmp/razkindo-archive';
            if (existsSync(p)) { try { const s = await getDirectorySizeAsync(p, []); rmSync(p, { recursive: true, force: true }); count = s; } catch { count = -1; } }
          } else if (target === 'tmp_my_project') {
            const p = '/tmp/my-project';
            if (existsSync(p)) { try { const s = await getDirectorySizeAsync(p, []); rmSync(p, { recursive: true, force: true }); count = s; } catch { count = -1; } }
          } else if (target === 'next_cache') {
            const p = join(process.cwd(), '.next', 'cache');
            if (existsSync(p)) { try { const s = await getDirectorySizeAsync(p, []); rmSync(p, { recursive: true, force: true }); count = s; } catch { count = -1; } }
          } else if (target === 'node_modules_cache') {
            const p = join(process.cwd(), 'node_modules', '.cache');
            if (existsSync(p)) { try { const s = await getDirectorySizeAsync(p, []); rmSync(p, { recursive: true, force: true }); count = s; } catch { count = -1; } }
          }
          // Database cleanup
          else if (target === 'old_logs_30d') {
            const { error } = await db.from('logs').delete().lt('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
            count = error ? -1 : 0;
          } else if (target === 'rejected_finance_requests') {
            const { data: linkedSalaryPayments } = await db.from('salary_payments').select('finance_request_id').not('finance_request_id', 'is', null);
            const excludeIds = (linkedSalaryPayments || []).map((r: Record<string, unknown>) => r.finance_request_id);
            let deleteQuery = db.from('finance_requests').delete().eq('status', 'rejected');
            if (excludeIds.length > 0) {
              deleteQuery = deleteQuery.not('id', 'in', excludeIds);
            }
            const { error } = await deleteQuery;
            count = error ? -1 : 0;
          } else if (target === 'rejected_salary_payments') {
            await db.from('salary_payments').update({ finance_request_id: null }).eq('status', 'rejected');
            const { error } = await db.from('salary_payments').delete().eq('status', 'rejected');
            count = error ? -1 : 0;
          } else if (target === 'cancelled_receivables') {
            const { data: cancelledIds } = await db.from('receivables').select('id').eq('status', 'cancelled');
            if (cancelledIds && cancelledIds.length > 0) {
              await db.from('receivable_follow_ups').delete().in('receivable_id', cancelledIds.map((r: Record<string, unknown>) => r.id));
            }
            const { error } = await db.from('receivables').delete().eq('status', 'cancelled');
            count = error ? -1 : 0;
          } else if (target === 'bad_debt_receivables') {
            const { data: badDebtIds } = await db.from('receivables').select('id').eq('status', 'bad_debt');
            if (badDebtIds && badDebtIds.length > 0) {
              await db.from('receivable_follow_ups').delete().in('receivable_id', badDebtIds.map((r: Record<string, unknown>) => r.id));
            }
            const { error } = await db.from('receivables').delete().eq('status', 'bad_debt');
            count = error ? -1 : 0;
          } else if (target === 'all_logs') {
            const { error } = await db.from('logs').delete().not('id', 'is', null);
            count = error ? -1 : 0;
          } else if (target === 'old_read_events_7d') {
            const { error } = await db.from('events').delete().eq('is_read', true).lt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
            count = error ? -1 : 0;
          } else if (target === 'all_read_events') {
            const { error } = await db.from('events').delete().eq('is_read', true);
            count = error ? -1 : 0;
          }
          results[target] = count;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error(`Cleanup error for ${target}:`, msg);
          results[target] = -1;
        }
      }

      // Invalidate cache after cleanup
      cache.clear();

      return NextResponse.json({ success: true, message: 'Cleanup berhasil dilakukan', results });
    }

    if (action === 'backup') {
      const allTables = ['users', 'units', 'products', 'unit_products', 'customers', 'suppliers', 'transactions', 'transaction_items', 'payments', 'salary_payments', 'bank_accounts', 'cash_boxes', 'finance_requests', 'fund_transfers', 'company_debts', 'company_debt_payments', 'receivables', 'receivable_follow_ups', 'sales_targets', 'courier_cash', 'courier_handovers', 'logs', 'events', 'settings'];
      // Parallel backup
      const backupResults = await Promise.all(
        allTables.map(async (table) => {
          const { data } = await db.from(table).select('*');
          return [table, data || []] as const;
        })
      );
      const backup = Object.fromEntries(backupResults);
      return NextResponse.json({ success: true, data: backup, exportedAt: new Date().toISOString() });
    }

    return NextResponse.json({ success: false, error: 'Action tidak valid' }, { status: 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Storage POST error:', message);
    return NextResponse.json({ success: false, error: 'Gagal memproses permintaan' }, { status: 500 });
  }
}
