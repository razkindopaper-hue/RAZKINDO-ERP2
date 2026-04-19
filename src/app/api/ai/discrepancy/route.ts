// =====================================================================
// AI DISCREPANCY ANALYSIS API
// Endpoint: POST /api/ai/discrepancy
//
// Provides:
// 1. ANALYZE — Deep discrepancy analysis across all financial data
// 2. ADJUST — Auto-fix transaction/payment inconsistencies (does NOT touch pool settings)
// 3. ROOT_CAUSE — AI-powered root cause investigation using LLM
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAndGetAuthUser } from '@/lib/token';
import { createLog } from '@/lib/supabase-helpers';

function rp(n: number) {
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

// =====================================================================
// ANALYZE: Comprehensive discrepancy detection
// =====================================================================

async function analyzeDiscrepancies() {
  const results: {
    poolVsRpc: any;
    poolVsPhysical: any;
    transactionInconsistencies: any[];
    paymentMismatches: any[];
    receivableMismatches: any[];
    summary: any;
  } = {
    poolVsRpc: null,
    poolVsPhysical: null,
    transactionInconsistencies: [],
    paymentMismatches: [],
    receivableMismatches: [],
    summary: null,
  };

  // 1. Pool Balance vs RPC Payment Sums (AUDIT ONLY — not a user-facing discrepancy)
  //    Settings table is the AUTHORITATIVE source for pool balances.
  //    RPC is just an independent verification/audit. After manual update,
  //    settings != RPC is NOT a real discrepancy.
  const { data: settings } = await db
    .from('settings')
    .select('key, value')
    .in('key', ['pool_hpp_paid_balance', 'pool_profit_paid_balance', 'pool_investor_fund']);

  const getVal = (key: string) => {
    const s = settings?.find((s: any) => s.key === key);
    return s ? (parseFloat(JSON.parse(s.value)) || 0) : 0;
  };

  const hppPaidBalance = getVal('pool_hpp_paid_balance');
  const profitPaidBalance = getVal('pool_profit_paid_balance');
  const investorFund = getVal('pool_investor_fund');
  const totalPool = hppPaidBalance + profitPaidBalance + investorFund;

  // Actual sums from payments
  const { data: sumsData, error: sumsError } = await db.rpc('get_payment_pool_sums');
  let actualHppSum = sumsData?.hppPaidTotal || 0;
  let actualProfitSum = sumsData?.profitPaidTotal || 0;
  if (sumsError) {
    const { data: fallback } = await db.from('payments').select('hpp_portion, profit_portion');
    actualHppSum = fallback?.reduce((sum: number, p: any) => sum + (Number(p.hpp_portion) || 0), 0) || 0;
    actualProfitSum = fallback?.reduce((sum: number, p: any) => sum + (Number(p.profit_portion) || 0), 0) || 0;
  }

  const hppDiff = hppPaidBalance - actualHppSum;
  const profitDiff = profitPaidBalance - actualProfitSum;

  // NOTE: We compute poolVsPhysical FIRST because poolVsRpc.hasDiscrepancy depends on it.
  // Pool vs Physical (Bank + Brankas) — PRIMARY discrepancy check
  // Dana kurir TIDAK termasuk karena belum disetor ke rekening/brankas
  const [bankResult, cashBoxResult, courierResult] = await Promise.all([
    db.from('bank_accounts').select('balance').eq('is_active', true),
    db.from('cash_boxes').select('balance').eq('is_active', true),
    db.from('courier_cash').select('balance'),
  ]);

  const totalBank = (bankResult.data || []).reduce((s: number, b: any) => s + (Number(b.balance) || 0), 0);
  const totalCashBox = (cashBoxResult.data || []).reduce((s: number, c: any) => s + (Number(c.balance) || 0), 0);
  const totalCourier = (courierResult.data || []).reduce((s: number, c: any) => s + (Number(c.balance) || 0), 0);
  const totalPhysical = totalBank + totalCashBox; // TANPA kurir
  const poolPhysicalDiff = totalPool - totalPhysical;
  const poolPhysicalHasDiscrepancy = Math.abs(poolPhysicalDiff) > 1;

  results.poolVsPhysical = {
    totalPool,
    totalBank,
    totalCashBox,
    totalCourier,
    totalPhysical,
    poolPhysicalDiff,
    hasDiscrepancy: poolPhysicalHasDiscrepancy,
  };

  // Pool vs RPC — Only flag as discrepancy if BOTH:
  //   (a) The difference is significant (abs > 1000)
  //   AND (b) The pool vs physical also has discrepancy
  // This prevents false alarms when user manually set correct values but RPC is wrong.
  const rpcDiffIsSignificant = Math.abs(hppDiff) > 1000 || Math.abs(profitDiff) > 1000;

  results.poolVsRpc = {
    hppPaidBalance,
    actualHppSum,
    hppDiff,
    profitPaidBalance,
    actualProfitSum,
    profitDiff,
    hasDiscrepancy: rpcDiffIsSignificant && poolPhysicalHasDiscrepancy,
  };

  // 2. Pool vs Physical was computed above (before poolVsRpc) since poolVsRpc depends on it
  // results.poolVsPhysical is already populated.

  // 3. Transaction Inconsistencies (total ≠ paid_amount + remaining_amount)
  const { data: allSaleTxs } = await db
    .from('transactions')
    .select('id, invoice_no, total, paid_amount, remaining_amount, payment_status, transaction_date')
    .eq('type', 'sale')
    .in('status', ['approved', 'paid'])
    .limit(3000);

  const inconsistencies = (allSaleTxs || [])
    .filter((t: any) => {
      const total = Number(t.total) || 0;
      const paid = Number(t.paid_amount) || 0;
      const remaining = Number(t.remaining_amount) || 0;
      return Math.abs(total - (paid + remaining)) > 1;
    })
    .map((t: any) => {
      const total = Number(t.total) || 0;
      const paid = Number(t.paid_amount) || 0;
      const remaining = Number(t.remaining_amount) || 0;
      return {
        id: t.id,
        invoiceNo: t.invoice_no,
        total,
        paid,
        remaining,
        expectedTotal: paid + remaining,
        discrepancy: total - (paid + remaining),
      };
    });

  results.transactionInconsistencies = inconsistencies.slice(0, 20);

  // 4. Payment Mismatches (paid_amount ≠ sum of payments)
  const allSaleTxIds = (allSaleTxs || []).map((t: any) => t.id);
  const txPaymentSumMap: Record<string, number> = {};
  if (allSaleTxIds.length > 0) {
    for (let i = 0; i < allSaleTxIds.length; i += 200) {
      const batch = allSaleTxIds.slice(i, i + 200);
      const { data: txPays } = await db
        .from('payments')
        .select('transaction_id, amount')
        .in('transaction_id', batch);
      if (txPays) {
        for (const p of txPays) {
          txPaymentSumMap[p.transaction_id] = (txPaymentSumMap[p.transaction_id] || 0) + (Number(p.amount) || 0);
        }
      }
    }
  }

  const paymentMismatches: any[] = [];
  const allSaleTxMap = new Map((allSaleTxs || []).map((t: any) => [t.id, t]));
  for (const [txId, sum] of Object.entries(txPaymentSumMap)) {
    const tx: any = allSaleTxMap.get(txId);
    if (!tx) continue;
    const paidAmount = Number(tx.paid_amount) || 0;
    if (Math.abs(paidAmount - sum) > 1) {
      paymentMismatches.push({
        id: txId,
        invoiceNo: tx.invoice_no,
        transactionPaidAmount: paidAmount,
        actualPaymentSum: sum,
        discrepancy: paidAmount - sum,
      });
    }
  }

  results.paymentMismatches = paymentMismatches.sort((a, b) => Math.abs(b.discrepancy) - Math.abs(a.discrepancy)).slice(0, 20);

  // 5. Receivable Mismatches (remaining_amount ≠ receivables.remaining_amount)
  const { data: receivables } = await db
    .from('receivables')
    .select('id, transaction_id, remaining_amount, status')
    .eq('status', 'active')
    .limit(500);

  if (receivables && receivables.length > 0) {
    const receivableTxIds = receivables.map((r: any) => r.transaction_id).filter(Boolean);
    if (receivableTxIds.length > 0) {
      const { data: receivableTxs } = await db
        .from('transactions')
        .select('id, invoice_no, remaining_amount')
        .in('id', receivableTxIds);

      const txRemainingMap = new Map((receivableTxs || []).map((t: any) => [t.id, Number(t.remaining_amount) || 0]));

      for (const r of receivables) {
        const txRemaining: number = txRemainingMap.get(r.transaction_id) || 0;
        const receivableRemaining = Number(r.remaining_amount) || 0;
        if (txRemaining !== undefined && Math.abs(txRemaining - receivableRemaining) > 1) {
          results.receivableMismatches.push({
            receivableId: r.id,
            transactionId: r.transaction_id,
            transactionRemaining: txRemaining,
            receivableRemaining,
            discrepancy: txRemaining - receivableRemaining,
          });
        }
      }
    }
  }

  // Summary
  const totalDiscrepancyCount = inconsistencies.length + paymentMismatches.length + results.receivableMismatches.length;
  const hasAnyDiscrepancy = results.poolVsPhysical.hasDiscrepancy || totalDiscrepancyCount > 0;

  results.summary = {
    hasAnyDiscrepancy,
    poolDiscrepancy: results.poolVsPhysical.hasDiscrepancy,
    physicalDiscrepancy: results.poolVsPhysical.hasDiscrepancy,
    rpcAuditDiscrepancy: results.poolVsRpc.hasDiscrepancy,
    inconsistencyCount: inconsistencies.length,
    paymentMismatchCount: paymentMismatches.length,
    receivableMismatchCount: results.receivableMismatches.length,
    totalDiscrepancyCount,
    hppRpcDiff: hppDiff,
    profitRpcDiff: profitDiff,
    poolPhysicalDiff,
  };

  return results;
}

// =====================================================================
// ADJUST: Auto-fix discrepancies
// =====================================================================

async function adjustDiscrepancies(userId: string) {
  const fixes: string[] = [];
  const errors: string[] = [];

  // NOTE: Pool settings are manually managed and AUTHORITATIVE.
  // Auto-adjust will NOT touch pool balances. Only fix transaction/payment inconsistencies.

  // 1. Fix transaction inconsistencies (total ≠ paid + remaining)
  const { data: inconsistentTxs } = await db
    .from('transactions')
    .select('id, invoice_no, total, paid_amount, remaining_amount')
    .eq('type', 'sale')
    .in('status', ['approved', 'paid'])
    .limit(3000);

  let fixedTxCount = 0;
  for (const tx of (inconsistentTxs || [])) {
    const total = Number(tx.total) || 0;
    const paid = Number(tx.paid_amount) || 0;
    const remaining = Number(tx.remaining_amount) || 0;
    const diff = Math.abs(total - (paid + remaining));
    if (diff > 1) {
      // Fix: set remaining_amount = total - paid_amount
      const newRemaining = Math.max(0, total - paid);
      try {
        await db.from('transactions').update({
          remaining_amount: newRemaining,
          updated_at: new Date().toISOString(),
        }).eq('id', tx.id);
        fixedTxCount++;
      } catch (err: any) {
        errors.push(`Gagal fix ${tx.invoice_no}: ${err.message}`);
      }
    }
  }
  if (fixedTxCount > 0) {
    fixes.push(`${fixedTxCount} transaksi inconsistency diperbaiki (remaining_amount disesuaikan)`);
  }

  // 2. Sync receivables from transactions
  const { data: activeReceivables } = await db
    .from('receivables')
    .select('id, transaction_id, remaining_amount, status, total_amount')
    .eq('status', 'active')
    .limit(500);

  let fixedReceivableCount = 0;
  if (activeReceivables && activeReceivables.length > 0) {
    const receivableTxIds = activeReceivables.map((r: any) => r.transaction_id).filter(Boolean);
    if (receivableTxIds.length > 0) {
      const { data: txs } = await db
        .from('transactions')
        .select('id, remaining_amount, payment_status')
        .in('id', receivableTxIds);

      const txMap = new Map((txs || []).map((t: any) => [t.id, t]));

      for (const r of activeReceivables) {
        const tx: any = txMap.get(r.transaction_id);
        if (!tx) continue;
        const txRemaining = Number(tx.remaining_amount) || 0;
        const recRemaining = Number(r.remaining_amount) || 0;
        // If transaction is fully paid, close the receivable (priority check)
        if (tx.payment_status === 'paid' && r.status === 'active') {
          try {
            await db.from('receivables').update({
              status: 'paid',
              remaining_amount: 0,
              paid_amount: Number(tx.remaining_amount) !== undefined ? recRemaining : (Number(r.total_amount) || 0),
              updated_at: new Date().toISOString(),
            }).eq('id', r.id);
            fixedReceivableCount++;
          } catch (err: any) {
            errors.push(`Gagal tutup piutang ${r.id}: ${err.message}`);
          }
        } else if (Math.abs(txRemaining - recRemaining) > 1) {
          try {
            await db.from('receivables').update({
              remaining_amount: txRemaining,
              updated_at: new Date().toISOString(),
            }).eq('id', r.id);
            fixedReceivableCount++;
          } catch (err: any) {
            errors.push(`Gagal fix piutang ${r.id}: ${err.message}`);
          }
        }
      }
    }
  }
  if (fixedReceivableCount > 0) {
    fixes.push(`${fixedReceivableCount} piutang disinkronkan dengan data transaksi`);
  }

  // Log the adjustment
  try {
    await createLog(db, {
      type: 'audit',
      userId,
      action: 'discrepancy_auto_adjusted',
      entity: 'finance',
      message: `Auto-adjustment: ${fixes.join('; ')}`,
    });
  } catch { /* ignore */ }

  return { fixes, errors };
}

// =====================================================================
// ROOT_CAUSE: AI-powered root cause analysis
// =====================================================================

async function findRootCause(discrepancyData: any) {
  const { chatCompletion, isAvailable } = await import('@/lib/ai');

  if (!isAvailable()) {
    return '⚠️ AI belum dikonfigurasi. Tambahkan GROQ_API_KEY di file .env untuk analisis akar penyebab otomatis. Dapatkan gratis di https://console.groq.com/keys';
  }

  // Build context string from discrepancy data
  const contextLines: string[] = [];
  contextLines.push('=== DATA DISCREPANCY RAZKINDO ===');
  contextLines.push('');

  // Primary check: Pool vs Dana Fisik
  if (discrepancyData.poolVsPhysical?.hasDiscrepancy) {
    const pvp = discrepancyData.poolVsPhysical;
    contextLines.push('--- POOL vs DANA FISIK (CHECK UTAMA) ---');
    contextLines.push(`Total Pool: ${rp(pvp.totalPool)}`);
    contextLines.push(`Bank: ${rp(pvp.totalBank)}, Brankas: ${rp(pvp.totalCashBox)}, Kurir: ${rp(pvp.totalCourier)}`);
    contextLines.push(`Total Fisik (brankas+bank, tanpa kurir): ${rp(pvp.totalPhysical)} (Selisih: ${rp(pvp.poolPhysicalDiff)})${pvp.totalCourier > 0 ? ` | Kurir (belum pool): ${rp(pvp.totalCourier)}` : ''}`);
    contextLines.push('');
  }

  // Audit only: Pool vs RPC
  if (discrepancyData.poolVsRpc?.hasDiscrepancy) {
    const pvr = discrepancyData.poolVsRpc;
    contextLines.push('--- POOL vs RPC (Audit) ---');
    contextLines.push(`Pool HPP: ${rp(pvr.hppPaidBalance)} vs RPC: ${rp(pvr.actualHppSum)} (Selisih: ${rp(pvr.hppDiff)})`);
    contextLines.push(`Pool Profit: ${rp(pvr.profitPaidBalance)} vs RPC: ${rp(pvr.actualProfitSum)} (Selisih: ${rp(pvr.profitDiff)})`);
    contextLines.push('(Catatan: Ini hanya audit, bukan selisih yang perlu diperbaiki)');
    contextLines.push('');
  }

  // Pool vs Physical is already shown above as the primary check
  // (No duplicate section needed here)

  if (discrepancyData.transactionInconsistencies?.length > 0) {
    contextLines.push('--- TRANSAKSI INKONSISTEN ---');
    discrepancyData.transactionInconsistencies.slice(0, 10).forEach((t: any) => {
      contextLines.push(`${t.invoiceNo}: total ${rp(t.total)} vs paid+remaining ${rp(t.expectedTotal)} (selisih ${rp(Math.abs(t.discrepancy))})`);
    });
    contextLines.push(`Total: ${discrepancyData.summary.inconsistencyCount} transaksi`);
    contextLines.push('');
  }

  if (discrepancyData.paymentMismatches?.length > 0) {
    contextLines.push('--- PAYMENT MISMATCH ---');
    discrepancyData.paymentMismatches.slice(0, 10).forEach((pm: any) => {
      contextLines.push(`${pm.invoiceNo}: paid_amount ${rp(pm.transactionPaidAmount)} vs actual payments ${rp(pm.actualPaymentSum)} (selisih ${rp(Math.abs(pm.discrepancy))})`);
    });
    contextLines.push(`Total: ${discrepancyData.summary.paymentMismatchCount} transaksi`);
    contextLines.push('');
  }

  if (discrepancyData.receivableMismatches?.length > 0) {
    contextLines.push('--- PIUTANG MISMATCH ---');
    discrepancyData.receivableMismatches.slice(0, 5).forEach((rm: any) => {
      contextLines.push(`Tx ${rm.transactionId}: transaksi remaining ${rp(rm.transactionRemaining)} vs piutang ${rp(rm.receivableRemaining)} (selisih ${rp(Math.abs(rm.discrepancy))})`);
    });
    contextLines.push('');
  }

  contextLines.push('=== AKHIR DATA ===');

  const systemPrompt = `Kamu adalah **Auditor Keuangan AI** untuk sistem ERP Razkindo Group. Kamu menganalisa data discrepancy (selisih) dan mencari AKAR PENYEBABNYA.

ATURAN:
- Gunakan Bahasa Indonesia
- Gunakan emoji (🔍⚠️💡🎯🔴🟢)
- Gunakan **bold** untuk angka penting
- Identifikasi POLA dan KORELASI antar discrepancy
- Berikan DIAGNOSIS akar penyebab yang spesifik (bukan umum)
- Berikan REKOMENDASI perbaikan yang actionable
- Jika ada beberapa kemungkinan, urutkan dari yang paling mungkin

FORMAT JAWABAN:
1. 🔍 **Temuan Selisih** — Ringkasan discrepancy yang ditemukan
2. 🎯 **Diagnosis Akar Penyebab** — Analisa mengapa selisih ini terjadi
3. 💡 **Rekomendasi Perbaikan** — Langkah konkret untuk mencegah di masa depan
4. ⚡ **Tindakan Segera** — Apa yang harus dilakukan SEKARANG`;

  try {
    const userMessage = `Analisa akar penyebab discrepancy berikut dan berikan diagnosis mendalam:\n\n${contextLines.join('\n')}`;
    const result = await chatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
    });
    return result.content || 'Gagal menganalisis akar penyebab.';
  } catch (err: any) {
    console.error('[AI] Root cause analysis error:', err);
    return '⚠️ AI sedang tidak tersedia untuk analisis akar penyebab. Coba lagi nanti.';
  }
}

// =====================================================================
// MAIN HANDLER
// =====================================================================

export async function POST(request: NextRequest) {
  try {
    const authResult = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (authResult.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden — hanya Super Admin' }, { status: 403 });
    }

    const body = await request.json();
    const { action } = body; // 'analyze', 'adjust', 'root_cause'

    if (!action || !['analyze', 'adjust', 'root_cause'].includes(action)) {
      return NextResponse.json({ error: 'Action harus: analyze, adjust, atau root_cause' }, { status: 400 });
    }

    // Step 1: Always analyze first
    const analysisData = await analyzeDiscrepancies();

    if (action === 'analyze') {
      return NextResponse.json({
        success: true,
        action: 'analyze',
        data: analysisData,
      });
    }

    if (action === 'adjust') {
      const adjustResult = await adjustDiscrepancies(authResult.userId);
      return NextResponse.json({
        success: true,
        action: 'adjust',
        fixes: adjustResult.fixes,
        errors: adjustResult.errors,
        beforeAnalysis: analysisData.summary,
      });
    }

    if (action === 'root_cause') {
      const rootCauseAnalysis = await findRootCause(analysisData);
      return NextResponse.json({
        success: true,
        action: 'root_cause',
        analysis: rootCauseAnalysis,
        data: analysisData,
      });
    }

    return NextResponse.json({ error: 'Action tidak valid' }, { status: 400 });
  } catch (error) {
    console.error('[AI Discrepancy] Error:', error);
    return NextResponse.json(
      { error: 'Gagal menganalisis discrepancy', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
