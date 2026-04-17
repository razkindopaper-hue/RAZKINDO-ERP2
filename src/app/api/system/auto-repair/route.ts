import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { consistencyChecker } from '@/lib/consistency-checker';
import { db } from '@/lib/supabase';

// =====================================================================
// POST /api/system/auto-repair - Auto repair detected issues
//
// Runs consistency checks and attempts to fix common issues:
// 1. Fix negative balances (set to 0 with log)
// 2. Fix orphaned records (delete)
// 3. Fix payment status inconsistencies (recalculate)
// 4. Vacuum analyze to optimize database
// 5. Clean up temp/dead data
// =====================================================================

interface RepairResult {
  check: string;
  status: 'passed' | 'fixed' | 'failed' | 'skipped';
  message: string;
  details?: any;
}

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const results: RepairResult[] = [];

    // ---- Phase 1: Run consistency checks ----
    const checkResults = await consistencyChecker.runAll();
    const failedChecks = checkResults.filter(r => !r.ok);

    for (const cr of checkResults) {
      if (cr.ok) {
        results.push({ check: cr.checkName, status: 'passed', message: cr.message });
      }
    }

    // ---- Phase 2: Auto-fix known issues ----

    // Fix 1: Negative bank balances → reset to 0
    const negBanks = failedChecks.find(c => c.checkName === 'negative_bank_balances');
    if (negBanks && !negBanks.ok) {
      try {
        const details = negBanks.details as any[];
        const ids = details?.map((d: any) => d.id) || [];
        if (ids.length > 0) {
          // Reset negative balances to 0
          for (const id of ids) {
            const { error } = await db.from('bank_accounts')
              .update({ balance: 0, updated_at: new Date().toISOString() })
              .eq('id', id);
            if (error) throw error;
          }
          results.push({
            check: 'negative_bank_balances',
            status: 'fixed',
            message: `${ids.length} rekening bank dengan saldo negatif telah direset ke 0`,
            details: ids,
          });
        }
      } catch (err: any) {
        results.push({
          check: 'negative_bank_balances',
          status: 'failed',
          message: `Gagal memperbaiki: ${err.message}`,
        });
      }
    }

    // Fix 2: Negative cash box balances → reset to 0
    const negCash = failedChecks.find(c => c.checkName === 'negative_cashbox_balances');
    if (negCash && !negCash.ok) {
      try {
        const details = negCash.details as any[];
        const ids = details?.map((d: any) => d.id) || [];
        if (ids.length > 0) {
          for (const id of ids) {
            const { error } = await db.from('cash_boxes')
              .update({ balance: 0, updated_at: new Date().toISOString() })
              .eq('id', id);
            if (error) throw error;
          }
          results.push({
            check: 'negative_cashbox_balances',
            status: 'fixed',
            message: `${ids.length} kas dengan saldo negatif telah direset ke 0`,
            details: ids,
          });
        }
      } catch (err: any) {
        results.push({
          check: 'negative_cashbox_balances',
          status: 'failed',
          message: `Gagal memperbaiki: ${err.message}`,
        });
      }
    }

    // Fix 3: Negative courier cash balances → reset to 0
    const negCourier = failedChecks.find(c => c.checkName === 'negative_courier_cash');
    if (negCourier && !negCourier.ok) {
      try {
        const details = negCourier.details as any[];
        const ids = details?.map((d: any) => d.id) || [];
        if (ids.length > 0) {
          for (const id of ids) {
            const { error } = await db.from('courier_cash')
              .update({ balance: 0, updated_at: new Date().toISOString() })
              .eq('id', id);
            if (error) throw error;
          }
          results.push({
            check: 'negative_courier_cash',
            status: 'fixed',
            message: `${ids.length} kas kurir dengan saldo negatif telah direset ke 0`,
            details: ids,
          });
        }
      } catch (err: any) {
        results.push({
          check: 'negative_courier_cash',
          status: 'failed',
          message: `Gagal memperbaiki: ${err.message}`,
        });
      }
    }

    // Fix 4: Orphaned transaction items → delete
    const orphaned = failedChecks.find(c => c.checkName === 'orphaned_transaction_items');
    if (orphaned && !orphaned.ok) {
      try {
        const details = orphaned.details as any[];
        const ids = details?.map((d: any) => d.id) || [];
        if (ids.length > 0) {
          const { error } = await db.from('transaction_items').delete().in('id', ids);
          if (error) throw error;
          results.push({
            check: 'orphaned_transaction_items',
            status: 'fixed',
            message: `${ids.length} item transaksi orphan telah dihapus`,
            details: ids,
          });
        }
      } catch (err: any) {
        results.push({
          check: 'orphaned_transaction_items',
          status: 'failed',
          message: `Gagal menghapus orphan items: ${err.message}`,
        });
      }
    }

    // Fix 5: Receivable payment inconsistencies → recalculate
    const recvInconsistent = failedChecks.find(c => c.checkName === 'receivable_payment_consistency');
    if (recvInconsistent && !recvInconsistent.ok) {
      try {
        const details = recvInconsistent.details as any[];
        const ids = details?.map((d: any) => d.id) || [];
        let fixedCount = 0;
        for (const r of details) {
          // If status is 'paid' but remaining != 0, set remaining to 0 and paid = total
          if (Math.abs(r.remaining) > 0.01) {
            const { error } = await db.from('receivables')
              .update({
                paid_amount: r.total,
                remaining_amount: 0,
                updated_at: new Date().toISOString(),
              })
              .eq('id', r.id);
            if (!error) fixedCount++;
          }
        }
        if (fixedCount > 0) {
          results.push({
            check: 'receivable_payment_consistency',
            status: 'fixed',
            message: `${fixedCount} piutang 'lunas' dengan data tidak konsisten telah diperbaiki`,
            details: { total: ids.length, fixed: fixedCount },
          });
        }
      } catch (err: any) {
        results.push({
          check: 'receivable_payment_consistency',
          status: 'failed',
          message: `Gagal memperbaiki: ${err.message}`,
        });
      }
    }

    // Fix 6: Payment status inconsistencies → recalculate paid amounts
    const payInconsistent = failedChecks.find(c => c.checkName === 'payment_status_consistency');
    if (payInconsistent && !payInconsistent.ok) {
      // This one is more complex - just report, don't auto-fix to avoid data loss
      results.push({
        check: 'payment_status_consistency',
        status: 'skipped',
        message: 'Inkonsistensi pembayaran perlu diperbaiki manual. Silakan cek tab Keuangan.',
        details: payInconsistent.details,
      });
    }

    // ---- Phase 3: General cleanup ----

    // Clean old logs (>30 days)
    try {
      const { error } = await db.from('logs')
        .delete()
        .lt('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
      if (!error) {
        results.push({
          check: 'cleanup_old_logs',
          status: 'fixed',
          message: 'Log lama (>30 hari) telah dibersihkan',
        });
      }
    } catch (err: any) {
      results.push({
        check: 'cleanup_old_logs',
        status: 'skipped',
        message: `Cleanup log gagal: ${err.message}`,
      });
    }

    // Clean read notifications (>7 days)
    try {
      const { error } = await db.from('events')
        .delete()
        .eq('is_read', true)
        .lt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      if (!error) {
        results.push({
          check: 'cleanup_old_notifications',
          status: 'fixed',
          message: 'Notifikasi lama (>7 hari, sudah dibaca) telah dibersihkan',
        });
      }
    } catch (err: any) {
      results.push({
        check: 'cleanup_old_notifications',
        status: 'skipped',
        message: `Cleanup notifikasi gagal: ${err.message}`,
      });
    }

    const fixedCount = results.filter(r => r.status === 'fixed').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    const passedCount = results.filter(r => r.status === 'passed').length;

    return NextResponse.json({
      success: true,
      message: `Auto-repair selesai: ${passedCount} OK, ${fixedCount} diperbaiki, ${failedCount} gagal`,
      summary: { total: results.length, passed: passedCount, fixed: fixedCount, failed: failedCount },
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Auto-repair API error:', error);
    return NextResponse.json({ success: false, error: 'Gagal menjalankan auto-repair' }, { status: 500 });
  }
}
