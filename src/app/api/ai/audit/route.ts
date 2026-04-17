// =====================================================================
// AI DEEP FINANCIAL AUDIT API
// Endpoint: GET /api/ai/audit
//
// Performs comprehensive financial discrepancy analysis:
// 1. Transaction consistency: total vs paid_amount + remaining_amount
// 2. Payment verification: paid_amount vs actual sum of payments
// 3. Receivable sync: receivables vs transaction payment_status
// 4. Pool balance vs actual: pool_hpp_paid_balance vs actual sum from transactions
// 5. Account balance reconciliation (bank, cash box, courier)
// 6. HPP/Profit field integrity checks
//
// Super Admin only.
// Returns structured data the AI can analyze.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAndGetAuthUser } from '@/lib/token';
import { toCamelCase, rowsToCamelCase, createLog } from '@/lib/supabase-helpers';

/** Round to 2 decimals */
function r2(n: number): number {
  return Math.round((n || 0) * 100) / 100;
}

function rp(n: number): string {
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

// =====================================================================
// MAIN HANDLER
// =====================================================================

export async function GET(request: NextRequest) {
  try {
    // ── AUTH ──
    const authResult = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (authResult.user.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Forbidden — hanya Super Admin yang dapat mengakses audit' },
        { status: 403 }
      );
    }

    // ====================================================================
    // PHASE 1: Fetch all data in parallel
    // ====================================================================

    const [
      // All sale transactions
      allSaleTxResult,
      // All settings for pool balances
      settingsResult,
      // All receivables (active)
      receivablesResult,
      // Bank accounts
      bankAccountsResult,
      // Cash boxes
      cashBoxesResult,
      // Courier cash
      courierCashResult,
    ] = await Promise.all([
      db
        .from('transactions')
        .select('id, invoice_no, total, paid_amount, remaining_amount, payment_status, status, total_hpp, total_profit, hpp_paid, hpp_unpaid, profit_paid, profit_unpaid, transaction_date, customer_id')
        .eq('type', 'sale')
        .in('status', ['approved', 'paid'])
        .order('transaction_date', { ascending: false })
        .limit(5000),

      db
        .from('settings')
        .select('key, value')
        .in('key', [
          'pool_hpp_paid_balance',
          'pool_profit_paid_balance',
          'pool_hpp_hand_balance',
          'pool_profit_hand_balance',
          'pool_investor_fund',
        ]),

      db
        .from('receivables')
        .select('id, transaction_id, customer_id, customer_name, total_amount, paid_amount, remaining_amount, status, overdue_days, created_at')
        .order('created_at', { ascending: false })
        .limit(1000),

      db
        .from('bank_accounts')
        .select('id, name, bank_name, balance, is_active')
        .order('name'),

      db
        .from('cash_boxes')
        .select('id, name, unit:units(name), balance, is_active')
        .order('name'),

      db
        .from('courier_cash')
        .select('id, courier_id, unit_id, balance, total_collected, total_handover'),
    ]);

    const allSaleTxs = allSaleTxResult.data || [];
    const settings = settingsResult.data || [];
    const receivables = receivablesResult.data || [];

    // ====================================================================
    // PHASE 2: Payment sums per transaction (batch fetch)
    // ====================================================================

    const allSaleTxIds = allSaleTxs.map((t: any) => t.id);
    const paymentSumMap: Record<string, number> = {};

    if (allSaleTxIds.length > 0) {
      const batchSize = 200;
      for (let i = 0; i < allSaleTxIds.length; i += batchSize) {
        const batch = allSaleTxIds.slice(i, i + batchSize);
        const { data: txPayments } = await db
          .from('payments')
          .select('transaction_id, amount, hpp_portion, profit_portion')
          .in('transaction_id', batch);

        if (txPayments) {
          for (const p of txPayments) {
            paymentSumMap[p.transaction_id] = (paymentSumMap[p.transaction_id] || 0) + (Number(p.amount) || 0);
          }
        }
      }
    }

    // ====================================================================
    // PHASE 3: Run all discrepancy checks
    // ====================================================================

    const critical: any[] = [];
    const warning: any[] = [];
    const info: any[] = [];

    // ── CHECK 1: Transaction consistency (total ≠ paid + remaining) ──
    const txInconsistencies = allSaleTxs.filter((t: any) => {
      const total = Number(t.total) || 0;
      const paid = Number(t.paid_amount) || 0;
      const remaining = Number(t.remaining_amount) || 0;
      return Math.abs(total - (paid + remaining)) > 1;
    });

    for (const t of txInconsistencies) {
      const total = Number(t.total) || 0;
      const paid = Number(t.paid_amount) || 0;
      const remaining = Number(t.remaining_amount) || 0;
      const expectedRemaining = total - paid;

      critical.push({
        type: 'transaction_inconsistency',
        severity: 'critical',
        transactionId: t.id,
        invoiceNo: t.invoice_no,
        description: `total ≠ paid_amount + remaining_amount`,
        currentValue: {
          total,
          paidAmount: paid,
          remainingAmount: remaining,
        },
        expectedValue: {
          remainingAmount: Math.max(0, expectedRemaining),
        },
        discrepancy: r2(total - (paid + remaining)),
        suggestedFix: {
          field: 'remaining_amount',
          correctValue: Math.max(0, expectedRemaining),
          reason: `remaining_amount harus ${rp(Math.max(0, expectedRemaining))} agar total = paid + remaining`,
        },
      });
    }

    // ── CHECK 2: Payment verification (paid_amount ≠ sum of payments) ──
    const paymentMismatches: any[] = [];
    for (const [txId, sum] of Object.entries(paymentSumMap)) {
      const tx = allSaleTxs.find((t: any) => t.id === txId);
      if (!tx) continue;
      const paidAmount = Number(tx.paid_amount) || 0;
      if (Math.abs(paidAmount - sum) > 1) {
        const fixPaid = Math.round(sum);
        const fixRemaining = Math.max(0, (Number(tx.total) || 0) - fixPaid);
        const fixStatus = fixRemaining <= 0 ? 'paid' : 'partial';

        paymentMismatches.push({
          type: 'payment_mismatch',
          severity: 'critical',
          transactionId: txId,
          invoiceNo: tx.invoice_no,
          description: `paid_amount (${rp(paidAmount)}) ≠ sum of payments (${rp(sum)})`,
          currentValue: {
            paidAmount,
            actualPaymentSum: sum,
          },
          expectedValue: {
            paidAmount: fixPaid,
          },
          discrepancy: r2(paidAmount - sum),
          suggestedFix: {
            field: 'paid_amount',
            correctValue: fixPaid,
            reason: `paid_amount disesuaikan ke jumlah pembayaran aktual (${rp(fixPaid)})`,
            additionalFixes: [
              { field: 'remaining_amount', correctValue: fixRemaining },
              { field: 'payment_status', correctValue: fixStatus },
            ],
          },
        });
      }
    }
    critical.push(...paymentMismatches);

    // ── CHECK 3: Receivable sync with transaction payment_status ──
    const txMap = new Map(allSaleTxs.map((t: any) => [t.id, t]));

    for (const r of receivables) {
      const tx = txMap.get(r.transaction_id);
      if (!tx) continue;

      const txRemaining = Number(tx.remaining_amount) || 0;
      const txPaid = Number(tx.paid_amount) || 0;
      const recRemaining = Number(r.remaining_amount) || 0;
      const recPaid = Number(r.paid_amount) || 0;
      const recTotal = Number(r.total_amount) || 0;

      // 3a: Remaining amount mismatch
      if (Math.abs(txRemaining - recRemaining) > 1) {
        warning.push({
          type: 'receivable_amount_mismatch',
          severity: 'warning',
          transactionId: r.transaction_id,
          receivableId: r.id,
          customerName: r.customer_name,
          description: `Piutang remaining (${rp(recRemaining)}) ≠ Transaksi remaining (${rp(txRemaining)})`,
          currentValue: { receivableRemaining: recRemaining, transactionRemaining: txRemaining },
          expectedValue: { receivableRemaining: txRemaining },
          discrepancy: r2(recRemaining - txRemaining),
          suggestedFix: {
            field: 'remaining_amount',
            correctValue: Math.round(txRemaining),
            reason: `Sinkronisasi piutang dengan data transaksi terbaru`,
          },
        });
      }

      // 3b: Transaction paid but receivable still active
      if (tx.payment_status === 'paid' && r.status === 'active') {
        critical.push({
          type: 'receivable_status_mismatch',
          severity: 'critical',
          transactionId: r.transaction_id,
          receivableId: r.id,
          customerName: r.customer_name,
          description: `Transaksi sudah LUNAS tapi piutang masih ACTIVE`,
          currentValue: { paymentStatus: 'paid', receivableStatus: 'active', remainingAmount: recRemaining },
          expectedValue: { receivableStatus: 'paid', remainingAmount: 0 },
          discrepancy: r2(recRemaining),
          suggestedFix: {
            field: 'status',
            correctValue: 'paid',
            reason: `Transaksi sudah lunas, piutang harus ditutup`,
            additionalFixes: [
              { field: 'remaining_amount', correctValue: 0 },
              { field: 'paid_amount', correctValue: recTotal },
            ],
          },
        });
      }

      // 3c: Paid/remaining don't match total in receivable
      if (Math.abs(recPaid + recRemaining - recTotal) > 1) {
        warning.push({
          type: 'receivable_sum_mismatch',
          severity: 'warning',
          transactionId: r.transaction_id,
          receivableId: r.id,
          customerName: r.customer_name,
          description: `Piutang: paid (${rp(recPaid)}) + remaining (${rp(recRemaining)}) ≠ total (${rp(recTotal)})`,
          currentValue: { paidAmount: recPaid, remainingAmount: recRemaining, totalAmount: recTotal },
          expectedValue: { remainingAmount: Math.max(0, recTotal - recPaid) },
          discrepancy: r2((recPaid + recRemaining) - recTotal),
          suggestedFix: {
            field: 'remaining_amount',
            correctValue: Math.max(0, recTotal - recPaid),
            reason: `remaining_amount disesuaikan agar paid + remaining = total`,
          },
        });
      }
    }

    // ── CHECK 4: Pool balance vs actual transaction sums ──
    const getSettingVal = (key: string) => {
      const s = settings.find((s: any) => s.key === key);
      if (!s) return 0;
      try {
        return parseFloat(JSON.parse(s.value)) || 0;
      } catch {
        return parseFloat(s.value) || 0;
      }
    };

    const poolHppPaid = getSettingVal('pool_hpp_paid_balance');
    const poolProfitPaid = getSettingVal('pool_profit_paid_balance');

    // Actual sums from all sale transactions
    const actualHppPaid = r2(allSaleTxs.reduce((s: number, t: any) => s + (Number(t.hpp_paid) || 0), 0));
    const actualProfitPaid = r2(allSaleTxs.reduce((s: number, t: any) => s + (Number(t.profit_paid) || 0), 0));

    if (Math.abs(poolHppPaid - actualHppPaid) > 1) {
      critical.push({
        type: 'pool_hpp_mismatch',
        severity: 'critical',
        description: `Pool HPP Paid (${rp(poolHppPaid)}) ≠ Aktual dari transaksi (${rp(actualHppPaid)})`,
        currentValue: { poolHppPaidBalance: poolHppPaid },
        expectedValue: { poolHppPaidBalance: actualHppPaid },
        discrepancy: r2(poolHppPaid - actualHppPaid),
        suggestedFix: {
          field: 'pool_hpp_paid_balance',
          correctValue: actualHppPaid,
          reason: `Sinkronisasi pool HPP dengan total hpp_paid dari semua transaksi`,
        },
      });
    }

    if (Math.abs(poolProfitPaid - actualProfitPaid) > 1) {
      critical.push({
        type: 'pool_profit_mismatch',
        severity: 'critical',
        description: `Pool Profit Paid (${rp(poolProfitPaid)}) ≠ Aktual dari transaksi (${rp(actualProfitPaid)})`,
        currentValue: { poolProfitPaidBalance: poolProfitPaid },
        expectedValue: { poolProfitPaidBalance: actualProfitPaid },
        discrepancy: r2(poolProfitPaid - actualProfitPaid),
        suggestedFix: {
          field: 'pool_profit_paid_balance',
          correctValue: actualProfitPaid,
          reason: `Sinkronisasi pool Profit dengan total profit_paid dari semua transaksi`,
        },
      });
    }

    // ── CHECK 5: Account balance health ──
    const bankAccounts = bankAccountsResult.data || [];
    const cashBoxes = cashBoxesResult.data || [];
    const courierCashList = courierCashResult.data || [];

    for (const b of bankAccounts) {
      if (Number(b.balance) < 0) {
        warning.push({
          type: 'negative_bank_balance',
          severity: 'warning',
          accountId: b.id,
          accountName: `${b.bank_name} - ${b.name}`,
          description: `Saldo rekening bank NEGATIF: ${rp(b.balance)}`,
          currentValue: { balance: Number(b.balance) },
          expectedValue: { balance: 0 },
          discrepancy: Number(b.balance),
          suggestedFix: null,
        });
      }
    }

    for (const cb of cashBoxes) {
      if (Number(cb.balance) < 0) {
        warning.push({
          type: 'negative_cashbox_balance',
          severity: 'warning',
          accountId: cb.id,
          accountName: `Brankas ${cb.name}${cb.unit?.name ? ` [${cb.unit.name}]` : ''}`,
          description: `Saldo brankas NEGATIF: ${rp(cb.balance)}`,
          currentValue: { balance: Number(cb.balance) },
          expectedValue: { balance: 0 },
          discrepancy: Number(cb.balance),
          suggestedFix: null,
        });
      }
    }

    for (const cc of courierCashList) {
      if (Number(cc.balance) < 0) {
        warning.push({
          type: 'negative_courier_balance',
          severity: 'warning',
          accountId: cc.id,
          description: `Saldo kas kurir NEGATIF: ${rp(cc.balance)}`,
          currentValue: { balance: Number(cc.balance) },
          expectedValue: { balance: 0 },
          discrepancy: Number(cc.balance),
          suggestedFix: null,
        });
      }
    }

    // ── CHECK 6: HPP/Profit field integrity ──
    const hppIntegrityIssues = allSaleTxs.filter((t: any) => {
      const total = Number(t.total) || 0;
      const hppPaid = Number(t.hpp_paid) || 0;
      const hppUnpaid = Number(t.hpp_unpaid) || 0;
      const profitPaid = Number(t.profit_paid) || 0;
      const profitUnpaid = Number(t.profit_unpaid) || 0;
      const paid = Number(t.paid_amount) || 0;
      const remaining = Number(t.remaining_amount) || 0;

      // hpp_paid should not exceed paid_amount
      if (hppPaid > paid + 1) return true;
      // profit_paid should not exceed paid_amount
      if (profitPaid > paid + 1) return true;
      // hpp_paid + hpp_unpaid should roughly equal total_hpp
      const totalHpp = Number(t.total_hpp) || 0;
      if (totalHpp > 0 && Math.abs((hppPaid + hppUnpaid) - totalHpp) > 1) return true;
      // profit_paid + profit_unpaid should roughly equal total_profit
      const totalProfit = Number(t.total_profit) || 0;
      if (totalProfit > 0 && Math.abs((profitPaid + profitUnpaid) - totalProfit) > 1) return true;

      return false;
    });

    for (const t of hppIntegrityIssues.slice(0, 20)) {
      const totalHpp = Number(t.total_hpp) || 0;
      const totalProfit = Number(t.total_profit) || 0;
      const hppPaid = Number(t.hpp_paid) || 0;
      const hppUnpaid = Number(t.hpp_unpaid) || 0;
      const profitPaid = Number(t.profit_paid) || 0;
      const profitUnpaid = Number(t.profit_unpaid) || 0;
      const paid = Number(t.paid_amount) || 0;

      info.push({
        type: 'hpp_profit_integrity',
        severity: 'info',
        transactionId: t.id,
        invoiceNo: t.invoice_no,
        description: `HPP/Profit field mungkin tidak konsisten`,
        currentValue: {
          totalHpp, hppPaid, hppUnpaid,
          totalProfit, profitPaid, profitUnpaid,
          paidAmount: paid,
        },
        expectedValue: null,
        discrepancy: null,
        suggestedFix: null,
      });
    }

    // ====================================================================
    // SUMMARY
    // ====================================================================

    const totalBank = bankAccounts.reduce((s: number, b: any) => s + (Number(b.balance) || 0), 0);
    const totalCashBox = cashBoxes.reduce((s: number, cb: any) => s + (Number(cb.balance) || 0), 0);
    const totalCourier = courierCashList.reduce((s: number, cc: any) => s + (Number(cc.balance) || 0), 0);

    const summary = {
      auditTimestamp: new Date().toISOString(),
      totalTransactions: allSaleTxs.length,
      totalReceivables: receivables.length,
      activeReceivables: receivables.filter((r: any) => r.status === 'active').length,

      criticalCount: critical.length,
      warningCount: warning.length,
      infoCount: info.length,

      checks: {
        transactionConsistency: {
          checked: allSaleTxs.length,
          issues: txInconsistencies.length,
          status: txInconsistencies.length === 0 ? 'ok' : 'has_issues',
        },
        paymentVerification: {
          checked: allSaleTxIds.length,
          issues: paymentMismatches.length,
          status: paymentMismatches.length === 0 ? 'ok' : 'has_issues',
        },
        receivableSync: {
          checked: receivables.length,
          issues: warning.filter(d => d.type.startsWith('receivable_')).length +
                  critical.filter(d => d.type.startsWith('receivable_')).length,
          status: warning.filter(d => d.type.startsWith('receivable_')).length === 0 &&
                  critical.filter(d => d.type.startsWith('receivable_')).length === 0 ? 'ok' : 'has_issues',
        },
        poolBalance: {
          hppPoolVsActual: Math.abs(poolHppPaid - actualHppPaid),
          profitPoolVsActual: Math.abs(poolProfitPaid - actualProfitPaid),
          status: Math.abs(poolHppPaid - actualHppPaid) <= 1 && Math.abs(poolProfitPaid - actualProfitPaid) <= 1 ? 'ok' : 'has_issues',
        },
        accountBalances: {
          totalBank: r2(totalBank),
          totalCashBox: r2(totalCashBox),
          totalCourier: r2(totalCourier),
          negativeAccounts: warning.filter(d => d.type.includes('negative')).length,
          status: warning.filter(d => d.type.includes('negative')).length === 0 ? 'ok' : 'has_issues',
        },
        hppProfitIntegrity: {
          issues: info.filter(d => d.type === 'hpp_profit_integrity').length,
          status: info.filter(d => d.type === 'hpp_profit_integrity').length === 0 ? 'ok' : 'has_issues',
        },
      },

      overallStatus: critical.length === 0 && warning.length === 0 ? 'healthy' :
                      critical.length > 0 ? 'critical' : 'warning',
    };

    // Log the audit
    try {
      await createLog(db, {
        type: 'audit',
        userId: authResult.userId,
        action: 'financial_audit',
        entity: 'finance',
        message: `Deep audit: ${critical.length} critical, ${warning.length} warning, ${info.length} info`,
      });
    } catch { /* ignore */ }

    // Sort by severity
    critical.sort((a, b) => Math.abs(b.discrepancy || 0) - Math.abs(a.discrepancy || 0));

    return NextResponse.json({
      success: true,
      data: {
        summary,
        discrepancies: {
          critical: critical.slice(0, 50),
          warning: warning.slice(0, 50),
          info: info.slice(0, 30),
        },
        meta: {
          totalCritical: critical.length,
          totalWarning: warning.length,
          totalInfo: info.length,
        },
      },
    });
  } catch (error) {
    console.error('[AI Audit] Error:', error);
    return NextResponse.json(
      { error: 'Gagal menjalankan audit keuangan', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
