import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { enforceFinanceRole } from '@/lib/require-auth';
import { createLog, generateId } from '@/lib/supabase-helpers';

// ============================================
// HELPER: Safe upsert for settings table
// Supabase REST doesn't auto-generate id, created_at, or updated_at.
// MUST use check-existing → update/insert pattern.
// ============================================
async function upsertSetting(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();

  const { data: existing } = await db
    .from('settings')
    .select('key')
    .eq('key', key)
    .maybeSingle();

  if (existing) {
    const { error } = await db
      .from('settings')
      .update({ value, updated_at: now })
      .eq('key', key);
    if (error) throw new Error(`Failed to update setting ${key}: ${error.message}`);
  } else {
    const { error } = await db
      .from('settings')
      .insert({
        id: generateId(),
        key,
        value,
        created_at: now,
        updated_at: now,
      });
    if (error) throw new Error(`Failed to insert setting ${key}: ${error.message}`);
  }
}

// ============================================
// HELPER: Parse a settings value safely (handles both raw numbers and JSON strings)
// ============================================
function parseSettingValue(s: { key: string; value: string } | undefined): number {
  if (!s) return 0;
  try {
    return parseFloat(JSON.parse(s.value)) || 0;
  } catch {
    return parseFloat(s.value) || 0;
  }
}

// ============================================
// HELPER: Fetch all pool settings in one query
// ============================================
async function fetchPoolSettings() {
  const { data: settings } = await db
    .from('settings')
    .select('key, value')
    .in('key', [
      'pool_hpp_paid_balance',
      'pool_profit_paid_balance',
      'pool_investor_fund',
    ]);

  const getVal = (key: string) => {
    const s = settings?.find((s: any) => s.key === key);
    return parseSettingValue(s);
  };

  return {
    hppPaidBalance: getVal('pool_hpp_paid_balance'),
    profitPaidBalance: getVal('pool_profit_paid_balance'),
    investorFund: getVal('pool_investor_fund'),
  };
}

// ============================================
// HELPER: Fetch courier cash aggregates (balance, hpp_pending, profit_pending)
// ============================================
async function fetchCourierCashSums() {
  const { data: courierCashRecords } = await db
    .from('courier_cash')
    .select('balance, hpp_pending, profit_pending');

  return (courierCashRecords || []).reduce(
    (acc: { balance: number; hppPending: number; profitPending: number }, cc: any) => ({
      balance: acc.balance + (cc.balance || 0),
      hppPending: acc.hppPending + (cc.hpp_pending || 0),
      profitPending: acc.profitPending + (cc.profit_pending || 0),
    }),
    { balance: 0, hppPending: 0, profitPending: 0 }
  );
}

// ============================================
// HELPER: Fetch physical cash totals (brankas + bank only)
// Pool dana = uang yang sudah masuk rekening/brankas.
// Dana kurir BELUM masuk pool karena belum disetor.
// ============================================
async function fetchPhysicalTotals() {
  // Sum of all active cash box balances (brankas)
  const { data: cashBoxes } = await db
    .from('cash_boxes')
    .select('balance')
    .eq('is_active', true);
  const totalCashInBoxes = (cashBoxes || []).reduce(
    (sum: number, cb: any) => sum + (Number(cb.balance) || 0),
    0
  );

  // Sum of all active bank account balances
  const { data: bankAccounts } = await db
    .from('bank_accounts')
    .select('balance')
    .eq('is_active', true);
  const totalInBanks = (bankAccounts || []).reduce(
    (sum: number, ba: any) => sum + (Number(ba.balance) || 0),
    0
  );

  // Sum of all courier cash in hand (INFO only, NOT part of pool)
  const courierSums = await fetchCourierCashSums();
  const totalWithCouriers = courierSums.balance;

  // Pool dana hanya = brankas + bank (uang yang sudah masuk perusahaan)
  // Dana kurir belum masuk karena belum disetor ke rekening/brankas
  return {
    totalCashInBoxes,
    totalInBanks,
    totalWithCouriers,
    totalPhysical: totalCashInBoxes + totalInBanks, // TANPA kurir
    courierSums,
  };
}

// ============================================
// HELPER: Fetch pool sums directly from Prisma
// (bypasses unreliable db.rpc() layer)
//
// Pool inflows:
//   1. Direct sale payments to brankas/bank
//   2. Courier handovers (setor ke brankas)
// Pool outflows:
//   - Finance requests paid from pools (not debt)
// ============================================
async function fetchPoolSumsFromPrisma() {
  try {
    // Inflow #1: Direct payments to brankas/bank
    const directPayments = await prisma.payment.aggregate({
      _sum: { hppPortion: true, profitPortion: true },
      where: {
        transaction: { type: 'sale' },
        OR: [
          { cashBoxId: { not: null } },
          { bankAccountId: { not: null } },
        ],
      },
    });

    // Inflow #2: Courier handovers (processed)
    const handovers = await prisma.courierHandover.aggregate({
      _sum: { hppPortion: true, profitPortion: true, amount: true },
      where: { status: 'processed' },
    });

    // Outflow: Finance requests deducted from pools
    const hppDeductions = await prisma.financeRequest.aggregate({
      _sum: { amount: true },
      where: { status: 'processed', fundSource: 'hpp_paid', paymentType: 'pay_now' },
    });

    const profitDeductions = await prisma.financeRequest.aggregate({
      _sum: { amount: true },
      where: { status: 'processed', fundSource: 'profit_unpaid', paymentType: 'pay_now' },
    });

    const directHpp = directPayments._sum.hppPortion || 0;
    const directProfit = directPayments._sum.profitPortion || 0;
    const handoverHpp = handovers._sum.hppPortion || 0;
    const handoverProfit = handovers._sum.profitPortion || 0;
    const hppDeducted = hppDeductions._sum.amount || 0;
    const profitDeducted = profitDeductions._sum.amount || 0;

    const hppPaidTotal = Math.round(directHpp + handoverHpp - hppDeducted);
    const profitPaidTotal = Math.round(directProfit + handoverProfit - profitDeducted);

    console.log('[POOL] Prisma sums: directHpp=%d, handoverHpp=%d, hppDeducted=%d → hppPaidTotal=%d | directProfit=%d, handoverProfit=%d, profitDeducted=%d → profitPaidTotal=%d',
      directHpp, handoverHpp, hppDeducted, hppPaidTotal, directProfit, handoverProfit, profitDeducted, profitPaidTotal);

    return {
      rpcHppSum: hppPaidTotal,
      rpcProfitSum: profitPaidTotal,
      directHpp,
      directProfit,
      handoverHpp,
      handoverProfit,
      handoverTotal: handovers._sum.amount || 0,
      hppDeducted,
      profitDeducted,
    };
  } catch (error) {
    console.error('[POOL] Prisma pool sums failed:', error);
    // Fallback: try Supabase REST queries (include handovers!)

    // 1. Direct payments to brankas/bank
    const { data: payments } = await db
      .from('payments')
      .select('hpp_portion, profit_portion, cash_box_id, bank_account_id');
    const directHpp = (payments || [])
      .filter((p: any) => p.cash_box_id || p.bank_account_id)
      .reduce((sum: number, p: any) => sum + (Number(p.hpp_portion) || 0), 0);
    const directProfit = (payments || [])
      .filter((p: any) => p.cash_box_id || p.bank_account_id)
      .reduce((sum: number, p: any) => sum + (Number(p.profit_portion) || 0), 0);

    // 2. Processed handovers (setor ke brankas via courier)
    const { data: handovers } = await db
      .from('courier_handovers')
      .select('hpp_portion, profit_portion, amount')
      .eq('status', 'processed');
    const handoverHpp = (handovers || [])
      .reduce((sum: number, h: any) => sum + (Number(h.hpp_portion) || 0), 0);
    const handoverProfit = (handovers || [])
      .reduce((sum: number, h: any) => sum + (Number(h.profit_portion) || 0), 0);

    // 3. Finance request deductions
    const { data: hppReqs } = await db
      .from('finance_requests')
      .select('amount')
      .eq('status', 'processed')
      .eq('fund_source', 'hpp_paid')
      .eq('payment_type', 'pay_now');
    const hppDeducted = (hppReqs || [])
      .reduce((sum: number, r: any) => sum + (Number(r.amount) || 0), 0);

    const { data: profitReqs } = await db
      .from('finance_requests')
      .select('amount')
      .eq('status', 'processed')
      .eq('fund_source', 'profit_unpaid')
      .eq('payment_type', 'pay_now');
    const profitDeducted = (profitReqs || [])
      .reduce((sum: number, r: any) => sum + (Number(r.amount) || 0), 0);

    const hppPaidTotal = Math.round(directHpp + handoverHpp - hppDeducted);
    const profitPaidTotal = Math.round(directProfit + handoverProfit - profitDeducted);

    return {
      rpcHppSum: hppPaidTotal,
      rpcProfitSum: profitPaidTotal,
      directHpp,
      directProfit,
      handoverHpp,
      handoverProfit,
      handoverTotal: (handovers || []).reduce((sum: number, h: any) => sum + (Number(h.amount) || 0), 0),
      hppDeducted,
      profitDeducted,
    };
  }
}

// ============================================
// GET /api/finance/pools
//
// Returns pool dana balances with the following philosophy:
// - Settings table IS the authoritative source for pool balances
// - Physical totals (brankas + bank + courier) are the real-world cash
// - selisih/discrepancy = pool composition vs physical cash
// - RPC values are for AUDIT/REFERENCE only, never used to overwrite settings
// ============================================
export async function GET(request: NextRequest) {
  try {
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. Authoritative pool balances from settings
    const poolSettings = await fetchPoolSettings();
    const { hppPaidBalance, profitPaidBalance, investorFund } = poolSettings;
    const totalPool = hppPaidBalance + profitPaidBalance + investorFund;

    // 2. Physical cash totals (brankas + bank only — kurir BUKAN bagian pool)
    const physical = await fetchPhysicalTotals();

    // 3. Pool vs physical discrepancy (pool vs brankas+bank)
    const poolDiff = totalPool - physical.totalPhysical;
    const hasDiscrepancy = Math.abs(poolDiff) > 100;

    // 4. Calculated pool sums (direct Prisma queries for accuracy)
    const rpc = await fetchPoolSumsFromPrisma();

    // 5. Diff: how much settings differ from calculated pool sums
    const rpcDiff = hppPaidBalance - rpc.rpcHppSum;

    return NextResponse.json({
      // ── AUTHORITATIVE pool balances (from settings) ──
      hppPaidBalance,
      profitPaidBalance,
      investorFund,
      totalPool,

      // ── Physical cash breakdown (brankas + bank only = pool dana) ──
      totalCashInBoxes: physical.totalCashInBoxes,
      totalInBanks: physical.totalInBanks,
      totalWithCouriers: physical.totalWithCouriers, // INFO only, NOT part of pool
      totalPhysical: physical.totalPhysical, // = brankas + bank (TANPA kurir)

      // ── Discrepancy: pool vs physical ──
      poolDiff,
      hasDiscrepancy,

      // ── Courier cash detail ──
      courierCashTotal: physical.courierSums.balance,
      courierHppPending: physical.courierSums.hppPending,
      courierProfitPending: physical.courierSums.profitPending,

      // ── Calculated pool sums (Prisma — for audit reference) ──
      rpcHppSum: rpc.rpcHppSum,
      rpcProfitSum: rpc.rpcProfitSum,
      rpcDiff,
      rpcBreakdown: {
        directHpp: rpc.directHpp,
        directProfit: rpc.directProfit,
        handoverHpp: rpc.handoverHpp,
        handoverProfit: rpc.handoverProfit,
        hppDeducted: rpc.hppDeducted,
        profitDeducted: rpc.profitDeducted,
      },
    });
  } catch (error) {
    console.error('Get pool balances error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

// ============================================
// PUT /api/finance/pools
//
// Manually update pool balances (settings IS the authority).
// totalPhysical = brankas + bank (TANPA kurir, karena dana kurir belum disetor).
// Safety check: total pool cannot exceed total physical (brankas+bank).
// ============================================
export async function PUT(request: NextRequest) {
  try {
    const auth = await enforceFinanceRole(request);
    if (!auth.success) return auth.response;

    const body = await request.json();
    const {
      hppPaidBalance,
      profitPaidBalance,
      investorFund: investorFundInput,
      totalPhysical,
    } = body;

    // Read current investor fund if not provided
    let investorFund = investorFundInput;
    if (investorFund === undefined || investorFund === null) {
      const { data: current } = await db
        .from('settings')
        .select('value')
        .eq('key', 'pool_investor_fund')
        .maybeSingle();
      investorFund = current ? parseSettingValue(current as any) : 0;
    } else {
      investorFund = Math.max(0, Math.round(Number(investorFund)));
    }

    // If totalPhysical is provided, auto-calculate HPP or Profit
    if (totalPhysical !== undefined && totalPhysical !== null) {
      const totalPhysicalNum = Math.round(Number(totalPhysical));
      const investorSafe = Math.max(0, investorFund);
      const poolFromOps = Math.max(0, totalPhysicalNum - investorSafe);

      let finalHpp: number;
      let finalProfit: number;

      if (hppPaidBalance !== undefined && hppPaidBalance !== null) {
        finalHpp = Math.max(0, Math.round(Number(hppPaidBalance)));
        if (finalHpp > poolFromOps) {
          return NextResponse.json({
            error: `HPP (${finalHpp.toLocaleString('id-ID')}) + Dana Lain-lain (${investorSafe.toLocaleString('id-ID')}) = ${(finalHpp + investorSafe).toLocaleString('id-ID')} melebihi total fisik (${totalPhysicalNum.toLocaleString('id-ID')})`
          }, { status: 400 });
        }
        finalProfit = Math.max(0, Math.round(poolFromOps - finalHpp));
      } else if (profitPaidBalance !== undefined && profitPaidBalance !== null) {
        finalProfit = Math.max(0, Math.round(Number(profitPaidBalance)));
        if (finalProfit > poolFromOps) {
          return NextResponse.json({
            error: `Profit (${finalProfit.toLocaleString('id-ID')}) + Dana Lain-lain (${investorSafe.toLocaleString('id-ID')}) = ${(finalProfit + investorSafe).toLocaleString('id-ID')} melebihi total fisik (${totalPhysicalNum.toLocaleString('id-ID')})`
          }, { status: 400 });
        }
        finalHpp = Math.max(0, Math.round(poolFromOps - finalProfit));
      } else {
        const currentSettings = await fetchPoolSettings();
        finalHpp = currentSettings.hppPaidBalance;
        finalProfit = currentSettings.profitPaidBalance;
      }

      const totalPool = finalHpp + finalProfit + investorSafe;
      if (totalPool > totalPhysicalNum) {
        return NextResponse.json({
          error: `Total Pool (${totalPool.toLocaleString('id-ID')}) melebihi total dana fisik (${totalPhysicalNum.toLocaleString('id-ID')})`
        }, { status: 400 });
      }

      // Update all three settings using safe upsert (check-existing → update/insert)
      await upsertSetting('pool_hpp_paid_balance', JSON.stringify(finalHpp));
      await upsertSetting('pool_profit_paid_balance', JSON.stringify(finalProfit));
      await upsertSetting('pool_investor_fund', JSON.stringify(investorSafe));

      try {
        createLog(db, {
          type: 'audit',
          action: 'pool_balances_updated',
          entity: 'settings',
          entityId: 'pool_hpp_paid_balance',
          userId: auth.userId,
          message: `Pool dana diperbarui: HPP=${finalHpp.toLocaleString('id-ID')}, Profit=${finalProfit.toLocaleString('id-ID')}, Dana Lain-lain=${investorSafe.toLocaleString('id-ID')}, Total=${totalPool.toLocaleString('id-ID')}`
        });
      } catch { /* ignore */ }

      return NextResponse.json({
        hppPaidBalance: finalHpp,
        profitPaidBalance: finalProfit,
        investorFund: investorSafe,
        totalPool,
        message: `Pool dana berhasil diperbarui. Total: ${totalPool.toLocaleString('id-ID')}`
      });
    }

    // Standalone investor fund update
    if (investorFundInput !== undefined && hppPaidBalance === undefined && profitPaidBalance === undefined) {
      await upsertSetting('pool_investor_fund', JSON.stringify(investorFund));

      const currentSettings = await fetchPoolSettings();
      const totalPool = currentSettings.hppPaidBalance + currentSettings.profitPaidBalance + investorFund;

      try {
        createLog(db, {
          type: 'audit',
          action: 'investor_fund_updated',
          entity: 'settings',
          entityId: 'pool_investor_fund',
          userId: auth.userId,
          message: `Dana lain-lain diperbarui: ${investorFund.toLocaleString('id-ID')}. Total pool: ${totalPool.toLocaleString('id-ID')}`
        });
      } catch { /* ignore */ }

      return NextResponse.json({
        hppPaidBalance: currentSettings.hppPaidBalance,
        profitPaidBalance: currentSettings.profitPaidBalance,
        investorFund,
        totalPool,
        message: `Dana lain-lain berhasil diperbarui: ${investorFund.toLocaleString('id-ID')}`
      });
    }

    return NextResponse.json({ error: 'Parameter tidak valid' }, { status: 400 });
  } catch (error) {
    console.error('Update pool balances error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

// ============================================
// HELPER: Compute sync preview
//
// Shows: current settings values vs RPC suggestion vs courier pending info.
// RPC values are "suggested values from RPC calculation" — NOT authoritative.
// Warnings are informational only — no blocking.
// ============================================
async function computeSyncPreview() {
  // 1. Current authoritative settings values
  const currentSettings = await fetchPoolSettings();
  const { hppPaidBalance: currentHpp, profitPaidBalance: currentProfit, investorFund: currentInvestorFund } = currentSettings;

  // 2. RPC suggested values (from DB calculation — for reference/suggestion)
  const rpc = await fetchPoolSumsFromPrisma();

  // 3. Courier pending amounts (money with couriers, not yet in brankas)
  //    Dana kurir TIDAK termasuk dalam pool karena belum disetor ke rekening/brankas.
  //    Informasi ini hanya untuk referensi/pemberitahuan.
  const courierSums = await fetchCourierCashSums();

  // 4. Suggested values = RPC (money already in brankas/bank via handover)
  //    Dana kurir TIDAK dimasukkan karena belum disetor ke rekening/brankas,
  //    jadi belum masuk pool dana.
  const suggestedHpp = Math.round(rpc.rpcHppSum);
  const suggestedProfit = Math.round(rpc.rpcProfitSum);

  // 5. Compute changes (current → suggested)
  const hppDelta = suggestedHpp - currentHpp;
  const profitDelta = suggestedProfit - currentProfit;

  const changes: { field: string; from: number; to: number; delta: number }[] = [];
  if (hppDelta !== 0) {
    changes.push({ field: 'HPP Terbayar', from: currentHpp, to: suggestedHpp, delta: hppDelta });
  }
  if (profitDelta !== 0) {
    changes.push({ field: 'Profit Terbayar', from: currentProfit, to: suggestedProfit, delta: profitDelta });
  }

  // 6. Generate informational warnings (NOT blocking)
  const warnings: string[] = [];
  const currentTotal = currentHpp + currentProfit + currentInvestorFund;
  const suggestedTotal = suggestedHpp + suggestedProfit + currentInvestorFund;

  if (suggestedHpp === 0 && suggestedProfit === 0 && currentTotal > 0) {
    warnings.push('⚠️ Hasil sync akan membuat HPP dan Profit keduanya menjadi 0. Ini biasanya berarti belum ada pembayaran yang masuk ke brankas/bank maupun setoran kurir.');
  }

  if (courierSums.hppPending > 0 || courierSums.profitPending > 0) {
    warnings.push(`📦 Dana kurir yang belum disetor: HPP ${courierSums.hppPending.toLocaleString('id-ID')}, Profit ${courierSums.profitPending.toLocaleString('id-ID')}. Dana ini BELUM masuk pool karena belum disetor ke rekening/brankas. Setelah kurir menyetor, baru masuk pool.`);
  }

  if (Math.abs(hppDelta) > currentHpp * 0.5 && currentHpp > 0) {
    warnings.push(`📉 Perubahan HPP sangat besar: dari ${currentHpp.toLocaleString('id-ID')} menjadi ${suggestedHpp.toLocaleString('id-ID')} (selisih ${hppDelta > 0 ? '+' : ''}${hppDelta.toLocaleString('id-ID')}). Pastikan data pembayaran dan setoran kurir sudah benar.`);
  }

  if (Math.abs(profitDelta) > currentProfit * 0.5 && currentProfit > 0) {
    warnings.push(`📉 Perubahan Profit sangat besar: dari ${currentProfit.toLocaleString('id-ID')} menjadi ${suggestedProfit.toLocaleString('id-ID')} (selisih ${profitDelta > 0 ? '+' : ''}${profitDelta.toLocaleString('id-ID')}). Pastikan data pembayaran dan setoran kurir sudah benar.`);
  }

  // 7. Total including courier (now part of pool by design)
  const totalWithCourier = suggestedTotal; // already includes courier pending

  return {
    // Current settings (authoritative)
    currentHpp,
    currentProfit,
    currentInvestorFund,
    currentTotalPool: currentTotal,

    // RPC suggestion (suggested values from RPC calculation)
    suggestedHpp,
    suggestedProfit,
    suggestedTotalPool: suggestedTotal,

    // Deltas
    hppDelta,
    profitDelta,

    // RPC breakdown (for transparency)
    rpcBreakdown: {
      directHpp: rpc.directHpp,
      directProfit: rpc.directProfit,
      handoverHpp: rpc.handoverHpp,
      handoverProfit: rpc.handoverProfit,
      hppDeducted: rpc.hppDeducted,
      profitDeducted: rpc.profitDeducted,
    },

    // Courier pending (money with couriers, not yet in brankas)
    courierHppPending: courierSums.hppPending,
    courierProfitPending: courierSums.profitPending,
    courierCashTotal: courierSums.balance,
    totalWithCourier,

    // Changes and warnings
    changes,
    warnings,
  };
}

// ============================================
// POST /api/finance/pools
//
// Actions:
//   - preview_sync: Show RPC suggestion + courier pending info (no changes)
//   - sync_from_payments: Set settings = RPC values (warnings only, no blocking)
//   - reset_to_zero: Reset all pool balances to 0
// ============================================
export async function POST(request: NextRequest) {
  try {
    const auth = await enforceFinanceRole(request);
    if (!auth.success) return auth.response;

    const body = await request.json();
    const { action } = body;

    // ── PREVIEW SYNC: Show what RPC suggests WITHOUT applying it ──
    if (action === 'preview_sync') {
      const syncPreview = await computeSyncPreview();
      return NextResponse.json({
        ...syncPreview,
        _info: 'Nilai "suggested" adalah hasil perhitungan dari data pembayaran + setoran kurir yang sudah masuk brankas/bank. Dana kurir yang belum disetor TIDAK termasuk dalam pool.',
      });
    }

    // ── SYNC FROM PAYMENTS: Set settings = RPC values (no blocking, just warnings) ──
    if (action === 'sync_from_payments') {
      const syncPreview = await computeSyncPreview();

      const newHpp = syncPreview.suggestedHpp;
      const newProfit = syncPreview.suggestedProfit;
      const investorFund = syncPreview.currentInvestorFund;

      // Use safe upsert to update settings
      await upsertSetting('pool_hpp_paid_balance', JSON.stringify(newHpp));
      await upsertSetting('pool_profit_paid_balance', JSON.stringify(newProfit));

      const totalPool = newHpp + newProfit + investorFund;

      try {
        createLog(db, {
          type: 'audit',
          action: 'pool_synced_from_payments',
          entity: 'settings',
          entityId: 'pool_hpp_paid_balance',
          userId: auth.userId,
          message: `Pool dana disinkronkan (brankas+bank, tanpa kurir): HPP=${newHpp.toLocaleString('id-ID')} (sebelumnya ${syncPreview.currentHpp.toLocaleString('id-ID')}), Profit=${newProfit.toLocaleString('id-ID')} (sebelumnya ${syncPreview.currentProfit.toLocaleString('id-ID')}), Dana Lain-lain=${investorFund.toLocaleString('id-ID')}, Total=${totalPool.toLocaleString('id-ID')}`
        });
      } catch { /* ignore */ }

      return NextResponse.json({
        hppPaidBalance: newHpp,
        profitPaidBalance: newProfit,
        investorFund,
        totalPool,
        changes: syncPreview.changes,
        warnings: syncPreview.warnings,
        message: `Pool dana berhasil disinkronkan (brankas+bank). HPP: ${newHpp.toLocaleString('id-ID')}, Profit: ${newProfit.toLocaleString('id-ID')}. Dana kurir tidak termasuk dalam pool.`,
      });
    }

    return NextResponse.json({ error: 'Action tidak valid. Gunakan: preview_sync atau sync_from_payments' }, { status: 400 });
  } catch (error) {
    console.error('Pool action error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
