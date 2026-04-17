import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
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

// GET /api/finance/pools
// Returns current pool balances for the 2-step finance workflow:
// - hppPaidBalance: HPP Sudah Terbayar — from settings (authoritative)
// - profitPaidBalance: Profit Sudah Terbayar — from settings (authoritative)
// - investorFund: Dana Lain-lain (investor, pinjaman, dll) — from settings
// - totalPool: hppPaidBalance + profitPaidBalance + investorFund
// - actualHppSum = hppPaidBalance (selisih always 0 after sync/manual update)
// - actualProfitSum = profitPaidBalance
// - rpcHppSum / rpcProfitSum: ground truth from DB (used by sync preview only)
export async function GET(request: NextRequest) {
  try {
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Read pool balances from settings table
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
      if (!s) return 0;
      try {
        return parseFloat(JSON.parse(s.value)) || 0;
      } catch {
        return parseFloat(s.value) || 0;
      }
    };

    const hppPaidBalance = getVal('pool_hpp_paid_balance');
    const profitPaidBalance = getVal('pool_profit_paid_balance');
    const investorFund = getVal('pool_investor_fund');

    // Get RPC ground truth (for sync preview / reference only)
    // actualHppSum/actualProfitSum now = settings values (selisih always 0)
    const { data: sumsData } = await db.rpc('get_payment_pool_sums');
    const rpcHppSum = sumsData?.hppPaidTotal || 0;
    const rpcProfitSum = sumsData?.profitPaidTotal || 0;
    const directHpp = sumsData?.directHpp || 0;
    const directProfit = sumsData?.directProfit || 0;
    const handoverHpp = sumsData?.handoverHpp || 0;
    const handoverProfit = sumsData?.handoverProfit || 0;
    const hppDeducted = sumsData?.hppDeducted || 0;
    const profitDeducted = sumsData?.profitDeducted || 0;

    // Get courier cash pending HPP/profit (money still held by couriers, not yet in brankas)
    const { data: courierCashRecords } = await db.from('courier_cash').select('balance, hpp_pending, profit_pending');
    const courierSums = (courierCashRecords || []).reduce((acc: { balance: number; hppPending: number; profitPending: number }, cc: any) => ({
      balance: acc.balance + (cc.balance || 0),
      hppPending: acc.hppPending + (cc.hpp_pending || 0),
      profitPending: acc.profitPending + (cc.profit_pending || 0),
    }), { balance: 0, hppPending: 0, profitPending: 0 });

    return NextResponse.json({
      hppPaidBalance,
      profitPaidBalance,
      investorFund,
      totalPool: hppPaidBalance + profitPaidBalance + investorFund,
      // actual = settings value (selisih always 0)
      actualHppSum: hppPaidBalance,
      actualProfitSum: profitPaidBalance,
      actualTotal: hppPaidBalance + profitPaidBalance,
      // RPC ground truth (for reference / sync preview)
      rpcHppSum,
      rpcProfitSum,
      // Breakdown: where does the ground truth come from?
      directHpp,
      directProfit,
      handoverHpp,
      handoverProfit,
      hppDeducted,
      profitDeducted,
      // HPP/profit still held by couriers (not yet in brankas)
      courierHppPending: courierSums?.hppPending || 0,
      courierProfitPending: courierSums?.profitPending || 0,
      courierCashTotal: courierSums?.balance || 0,
    });
  } catch (error) {
    console.error('Get pool balances error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

// PUT /api/finance/pools
// Manually update pool balances
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
      investorFund = current ? (parseFloat(JSON.parse(current.value)) || 0) : 0;
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
        const { data: currentHpp } = await db.from('settings').select('value').eq('key', 'pool_hpp_paid_balance').maybeSingle();
        const { data: currentProfit } = await db.from('settings').select('value').eq('key', 'pool_profit_paid_balance').maybeSingle();
        finalHpp = currentHpp ? (parseFloat(JSON.parse(currentHpp.value)) || 0) : 0;
        finalProfit = currentProfit ? (parseFloat(JSON.parse(currentProfit.value)) || 0) : 0;
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

      const { data: currentHpp } = await db.from('settings').select('value').eq('key', 'pool_hpp_paid_balance').maybeSingle();
      const { data: currentProfit } = await db.from('settings').select('value').eq('key', 'pool_profit_paid_balance').maybeSingle();
      const currentHppVal = currentHpp ? (parseFloat(JSON.parse(currentHpp.value)) || 0) : 0;
      const currentProfitVal = currentProfit ? (parseFloat(JSON.parse(currentProfit.value)) || 0) : 0;
      const totalPool = currentHppVal + currentProfitVal + investorFund;

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
        hppPaidBalance: currentHppVal,
        profitPaidBalance: currentProfitVal,
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
// HELPER: Compute sync preview with safety checks
// Returns current vs new values, changes, warnings, and courier pending amounts
// ============================================
async function computeSyncPreview() {
  // Get current pool balances
  const { data: currentSettings } = await db
    .from('settings')
    .select('key, value')
    .in('key', ['pool_hpp_paid_balance', 'pool_profit_paid_balance', 'pool_investor_fund']);

  const getCurrentVal = (key: string) => {
    const s = currentSettings?.find((s: any) => s.key === key);
    if (!s) return 0;
    try { return parseFloat(JSON.parse(s.value)) || 0; }
    catch { return parseFloat(s.value) || 0; }
  };

  const currentHpp = getCurrentVal('pool_hpp_paid_balance');
  const currentProfit = getCurrentVal('pool_profit_paid_balance');
  const currentInvestorFund = getCurrentVal('pool_investor_fund');

  // Get actual pool sums from DB (ground truth) — now includes handovers + deductions
  const { data: sumsData, error: sumsError } = await db.rpc('get_payment_pool_sums');
  let newHpp = sumsData?.hppPaidTotal || 0;
  let newProfit = sumsData?.profitPaidTotal || 0;
  const directHpp = sumsData?.directHpp || 0;
  const directProfit = sumsData?.directProfit || 0;
  const handoverHpp = sumsData?.handoverHpp || 0;
  const handoverProfit = sumsData?.handoverProfit || 0;
  const hppDeducted = sumsData?.hppDeducted || 0;
  const profitDeducted = sumsData?.profitDeducted || 0;
  if (sumsError) {
    console.error('[POOL SYNC PREVIEW] RPC failed, falling back to direct query:', sumsError.message);
    const { data: fallback } = await db.from('payments').select('hpp_portion, profit_portion, cash_box_id, bank_account_id');
    newHpp = fallback?.filter((p: any) => p.cash_box_id || p.bank_account_id).reduce((sum: number, p: any) => sum + (Number(p.hpp_portion) || 0), 0) || 0;
    newProfit = fallback?.filter((p: any) => p.cash_box_id || p.bank_account_id).reduce((sum: number, p: any) => sum + (Number(p.profit_portion) || 0), 0) || 0;
  }

  const roundedNewHpp = Math.round(newHpp);
  const roundedNewProfit = Math.round(newProfit);

  // Get courier cash pending (money with couriers, not yet in brankas)
  const { data: courierCashRecords } = await db.from('courier_cash').select('balance, hpp_pending, profit_pending');
  const courierSums = (courierCashRecords || []).reduce((acc: { balance: number; hppPending: number; profitPending: number }, cc: any) => ({
    balance: acc.balance + (cc.balance || 0),
    hppPending: acc.hppPending + (cc.hpp_pending || 0),
    profitPending: acc.profitPending + (cc.profit_pending || 0),
  }), { balance: 0, hppPending: 0, profitPending: 0 });

  // Compute changes
  const changes: { field: string; from: number; to: number; delta: number }[] = [];
  const hppDelta = roundedNewHpp - currentHpp;
  const profitDelta = roundedNewProfit - currentProfit;
  if (hppDelta !== 0) {
    changes.push({ field: 'HPP Terbayar', from: currentHpp, to: roundedNewHpp, delta: hppDelta });
  }
  if (profitDelta !== 0) {
    changes.push({ field: 'Profit Terbayar', from: currentProfit, to: roundedNewProfit, delta: profitDelta });
  }

  // Generate warnings
  const warnings: string[] = [];
  const currentTotal = currentHpp + currentProfit + currentInvestorFund;
  const newTotal = roundedNewHpp + roundedNewProfit + currentInvestorFund;

  if (roundedNewHpp === 0 && roundedNewProfit === 0 && currentTotal > 0) {
    warnings.push('⚠️ Hasil sync akan membuat HPP dan Profit keduanya menjadi 0. Ini biasanya berarti belum ada pembayaran yang masuk ke brankas/bank maupun setoran kurir.');
  }

  if (courierSums.hppPending > 0 || courierSums.profitPending > 0) {
    warnings.push(`📦 Masih ada dana di kurir yang belum disetor: HPP ${courierSums.hppPending.toLocaleString('id-ID')}, Profit ${courierSums.profitPending.toLocaleString('id-ID')}. Dana ini TIDAK termasuk dalam pool (akan masuk saat kurir setor ke brankas).`);
  }

  if (Math.abs(hppDelta) > currentHpp * 0.5 && currentHpp > 0) {
    warnings.push(`📉 Perubahan HPP sangat besar: dari ${currentHpp.toLocaleString('id-ID')} menjadi ${roundedNewHpp.toLocaleString('id-ID')} (selisih ${hppDelta > 0 ? '+' : ''}${hppDelta.toLocaleString('id-ID')}). Pastikan data pembayaran dan setoran kurir sudah benar.`);
  }

  if (Math.abs(profitDelta) > currentProfit * 0.5 && currentProfit > 0) {
    warnings.push(`📉 Perubahan Profit sangat besar: dari ${currentProfit.toLocaleString('id-ID')} menjadi ${roundedNewProfit.toLocaleString('id-ID')} (selisih ${profitDelta > 0 ? '+' : ''}${profitDelta.toLocaleString('id-ID')}). Pastikan data pembayaran dan setoran kurir sudah benar.`);
  }

  // The "correct" total should include courier pending amounts (full expected income)
  const totalWithCourier = roundedNewHpp + roundedNewProfit + courierSums.hppPending + courierSums.profitPending + currentInvestorFund;

  return {
    currentHpp,
    currentProfit,
    currentInvestorFund,
    currentTotalPool: currentTotal,
    newHpp: roundedNewHpp,
    newProfit: roundedNewProfit,
    newTotalPool: newTotal,
    hppDelta,
    profitDelta,
    // Breakdown of ground truth calculation
    directHpp,
    directProfit,
    handoverHpp,
    handoverProfit,
    hppDeducted,
    profitDeducted,
    // Courier pending
    courierHppPending: courierSums.hppPending,
    courierProfitPending: courierSums.profitPending,
    courierCashTotal: courierSums.balance,
    totalWithCourier,
    changes,
    warnings,
    isSafe: warnings.length === 0 && !(currentTotal > 0 && newTotal === 0),
    wouldZero: currentTotal > 0 && newTotal === 0,
    drasticChange: currentTotal > 0 && newTotal < currentTotal * 0.2,
  };
}

// POST /api/finance/pools
// Actions: sync_from_payments, preview_sync, reset_to_zero
export async function POST(request: NextRequest) {
  try {
    const auth = await enforceFinanceRole(request);
    if (!auth.success) return auth.response;

    const body = await request.json();
    const { action, force } = body;

    // ── PREVIEW SYNC: Show what sync would change WITHOUT applying it ──
    if (action === 'preview_sync') {
      const syncPreview = await computeSyncPreview();
      return NextResponse.json(syncPreview);
    }

    if (action === 'sync_from_payments') {
      // ── SAFETY: Compute sync preview first to validate ──
      const syncPreview = await computeSyncPreview();

      // Prevent sync if result would zero out existing non-zero balances
      // unless force=true is explicitly passed
      if (!force) {
        const currentTotal = syncPreview.currentHpp + syncPreview.currentProfit + syncPreview.currentInvestorFund;
        const newTotal = syncPreview.newHpp + syncPreview.newProfit + syncPreview.currentInvestorFund;

        // Block sync if it would reduce total pool by more than 50% or to zero when current > 0
        if (currentTotal > 0 && newTotal === 0) {
          return NextResponse.json({
            error: 'Sinkronisasi dibatalkan: Hasil sync akan membuat total pool menjadi 0. Ini kemungkinan besar terjadi karena data pembayaran ke brankas/bank belum lengkap. Gunakan "Preview Sinkron" untuk melihat detail, atau hubungi admin jika yakin ingin memaksa sync.',
            code: 'SYNC_WOULD_ZERO',
            preview: syncPreview,
          }, { status: 400 });
        }

        // Warn if change is too drastic (>80% reduction)
        if (currentTotal > 0 && newTotal < currentTotal * 0.2) {
          return NextResponse.json({
            error: `Sinkronisasi dibatalkan: Hasil sync akan mengurangi total pool dari ${currentTotal.toLocaleString('id-ID')} menjadi ${newTotal.toLocaleString('id-ID')} (penurunan >80%). Gunakan "Preview Sinkron" untuk melihat detail, atau paksa sync jika yakin.`,
            code: 'SYNC_DRASTIC_CHANGE',
            preview: syncPreview,
          }, { status: 400 });
        }

        // Block if both HPP and Profit would become 0 when they were previously non-zero
        if (syncPreview.currentHpp > 0 && syncPreview.newHpp === 0 && syncPreview.currentProfit > 0 && syncPreview.newProfit === 0) {
          return NextResponse.json({
            error: 'Sinkronisasi dibatalkan: Baik HPP maupun Profit akan menjadi 0. Data pembayaran ke brankas/bank mungkin belum lengkap. Gunakan "Preview Sinkron" untuk melihat detail.',
            code: 'SYNC_WOULD_ZERO_BOTH',
            preview: syncPreview,
          }, { status: 400 });
        }
      }

      const roundedHpp = syncPreview.newHpp;
      const roundedProfit = syncPreview.newProfit;
      const investorFund = syncPreview.currentInvestorFund;

      // Use safe upsert instead of Supabase REST upsert
      await upsertSetting('pool_hpp_paid_balance', JSON.stringify(roundedHpp));
      await upsertSetting('pool_profit_paid_balance', JSON.stringify(roundedProfit));

      const totalPool = roundedHpp + roundedProfit + investorFund;

      try {
        createLog(db, {
          type: 'audit',
          action: 'pool_synced_from_payments',
          entity: 'settings',
          entityId: 'pool_hpp_paid_balance',
          userId: auth.userId,
          message: `Pool dana disinkronkan dari pembayaran: HPP=${roundedHpp.toLocaleString('id-ID')} (sebelumnya ${syncPreview.currentHpp.toLocaleString('id-ID')}), Profit=${roundedProfit.toLocaleString('id-ID')} (sebelumnya ${syncPreview.currentProfit.toLocaleString('id-ID')}), Dana Lain-lain=${investorFund.toLocaleString('id-ID')}, Total=${totalPool.toLocaleString('id-ID')}${force ? ' [FORCED]' : ''}`
        });
      } catch { /* ignore */ }

      return NextResponse.json({
        hppPaidBalance: roundedHpp,
        profitPaidBalance: roundedProfit,
        investorFund,
        totalPool,
        changes: syncPreview.changes,
        warnings: syncPreview.warnings,
        message: `Pool dana berhasil disinkronkan dari data pembayaran. HPP: ${roundedHpp.toLocaleString('id-ID')}, Profit: ${roundedProfit.toLocaleString('id-ID')}`
      });
    }

    if (action === 'reset_to_zero') {
      // Reset all pool balances to 0 using safe upsert
      await upsertSetting('pool_hpp_paid_balance', JSON.stringify(0));
      await upsertSetting('pool_profit_paid_balance', JSON.stringify(0));
      await upsertSetting('pool_investor_fund', JSON.stringify(0));

      // Verify the values were actually saved
      const { data: verifySettings } = await db
        .from('settings')
        .select('key, value')
        .in('key', ['pool_hpp_paid_balance', 'pool_profit_paid_balance', 'pool_investor_fund']);
      console.log('[POOL RESET] Verification after reset:', JSON.stringify(verifySettings));

      try {
        createLog(db, {
          type: 'audit',
          action: 'pool_reset_to_zero',
          entity: 'settings',
          entityId: 'pool_hpp_paid_balance',
          userId: auth.userId,
          message: 'Pool dana direset ke 0'
        });
      } catch { /* ignore */ }

      return NextResponse.json({
        hppPaidBalance: 0,
        profitPaidBalance: 0,
        investorFund: 0,
        totalPool: 0,
        message: 'Pool dana berhasil direset ke 0'
      });
    }

    return NextResponse.json({ error: 'Action tidak valid. Gunakan: preview_sync, sync_from_payments, atau reset_to_zero' }, { status: 400 });
  } catch (error) {
    console.error('Pool action error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
