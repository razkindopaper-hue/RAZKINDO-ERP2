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
// - hppPaidBalance: HPP Sudah Terbayar (cost recovery from customer payments) — from settings
// - profitPaidBalance: Profit Sudah Terbayar (profit from customer payments) — from settings
// - investorFund: Dana Lain-lain (investor, pinjaman, dll) — from settings
// - totalPool: hppPaidBalance + profitPaidBalance + investorFund
// - actualHppSum: SUM of hpp_portion from all sale payments (ground truth from DB)
// - actualProfitSum: SUM of profit_portion from all sale payments (ground truth from DB)
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

    // Get actual payment sums from DB (ground truth) via Prisma RPC
    // Only counts payments deposited to brankas/bank (not courier cash)
    const { data: sumsData, error: sumsError } = await db.rpc('get_payment_pool_sums');
    let actualHppSum = sumsData?.hppPaidTotal || 0;
    let actualProfitSum = sumsData?.profitPaidTotal || 0;
    if (sumsError) {
      console.error('[POOL] RPC get_payment_pool_sums failed, falling back to direct query:', sumsError.message);
      // Fallback: only sum payments deposited to brankas/bank
      const { data: fallback } = await db.from('payments').select('hpp_portion, profit_portion, cash_box_id, bank_account_id');
      actualHppSum = fallback?.filter((p: any) => p.cash_box_id || p.bank_account_id).reduce((sum: number, p: any) => sum + (Number(p.hpp_portion) || 0), 0) || 0;
      actualProfitSum = fallback?.filter((p: any) => p.cash_box_id || p.bank_account_id).reduce((sum: number, p: any) => sum + (Number(p.profit_portion) || 0), 0) || 0;
    }

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
      actualHppSum,
      actualProfitSum,
      actualTotal: actualHppSum + actualProfitSum,
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

// POST /api/finance/pools
// Actions: sync_from_payments, reset_to_zero
export async function POST(request: NextRequest) {
  try {
    const auth = await enforceFinanceRole(request);
    if (!auth.success) return auth.response;

    const body = await request.json();
    const { action } = body;

    if (action === 'sync_from_payments') {
      // Sync pool balances from actual payment sums (only brankas/bank payments)
      // POOL BALANCE FIX: Exclude courier cash collection payments (no cashBoxId/bankAccountId)
      // since those are tracked in courier_cash and will be added to pool at handover time.
      const { data: sumsData, error: sumsError } = await db.rpc('get_payment_pool_sums');
      let newHpp = sumsData?.hppPaidTotal || 0;
      let newProfit = sumsData?.profitPaidTotal || 0;
      if (sumsError) {
        console.error('[POOL SYNC] RPC failed, falling back to direct query:', sumsError.message);
        // Fallback: only sum payments deposited to brankas/bank
        const { data: fallback } = await db.from('payments').select('hpp_portion, profit_portion, cash_box_id, bank_account_id');
        newHpp = fallback?.filter((p: any) => p.cash_box_id || p.bank_account_id).reduce((sum: number, p: any) => sum + (Number(p.hpp_portion) || 0), 0) || 0;
        newProfit = fallback?.filter((p: any) => p.cash_box_id || p.bank_account_id).reduce((sum: number, p: any) => sum + (Number(p.profit_portion) || 0), 0) || 0;
      }

      const roundedHpp = Math.round(newHpp);
      const roundedProfit = Math.round(newProfit);

      const { data: current } = await db
        .from('settings')
        .select('value')
        .eq('key', 'pool_investor_fund')
        .maybeSingle();
      const investorFund = current ? (parseFloat(JSON.parse(current.value)) || 0) : 0;

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
          message: `Pool dana disinkronkan dari pembayaran: HPP=${roundedHpp.toLocaleString('id-ID')}, Profit=${roundedProfit.toLocaleString('id-ID')}, Dana Lain-lain=${investorFund.toLocaleString('id-ID')}, Total=${totalPool.toLocaleString('id-ID')}`
        });
      } catch { /* ignore */ }

      return NextResponse.json({
        hppPaidBalance: roundedHpp,
        profitPaidBalance: roundedProfit,
        investorFund,
        totalPool,
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

    return NextResponse.json({ error: 'Action tidak valid. Gunakan: sync_from_payments atau reset_to_zero' }, { status: 400 });
  } catch (error) {
    console.error('Pool action error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
