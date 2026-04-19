import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, createEvent, generateId } from '@/lib/supabase-helpers';
import { verifyAndGetAuthUser } from '@/lib/token';
import { atomicUpdateBalance, atomicUpdatePoolBalance } from '@/lib/atomic-ops';

// =====================================================================
// Cashback Withdrawal Processing — Super Admin & Keuangan (Finance)
// PATCH /api/cashback/withdrawals/[id] — Approve/reject/process
//
// Processing flow:
//   pending → approved (anyone can approve)
//   approved → processed (finance processes with source + destination)
//   pending → rejected (refund cashback to customer)
//
// When processed, the system:
//   1. Deducts from chosen source pool (profit_paid or hpp_paid)
//   2. Deducts from chosen destination (bank_account or cash_box)
// =====================================================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authUserId = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authUserId || !['super_admin', 'keuangan'].includes(authUserId.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const data = await request.json();

    if (!['approved', 'rejected', 'processed'].includes(data.status)) {
      return NextResponse.json({ error: 'Status tidak valid' }, { status: 400 });
    }

    // Fetch withdrawal (no PostgREST joins — CashbackWithdrawal has no Prisma relations)
    const { data: withdrawal } = await db
      .from('cashback_withdrawal')
      .select('*')
      .eq('id', id)
      .single();

    if (!withdrawal) {
      return NextResponse.json({ error: 'Pencairan tidak ditemukan' }, { status: 404 });
    }

    if (withdrawal.status !== 'pending' && withdrawal.status !== 'approved') {
      return NextResponse.json({ error: `Pencairan dengan status "${withdrawal.status}" tidak dapat diubah` }, { status: 400 });
    }

    // Validate state transitions
    if (data.status === 'processed' && withdrawal.status !== 'approved') {
      return NextResponse.json({ error: 'Pencairan harus disetujui terlebih dahulu sebelum diproses' }, { status: 400 });
    }

    // Fetch customer for balance operations (separate query, no join)
    const { data: customer } = await db
      .from('customers')
      .select('id, name, cashback_balance')
      .eq('id', withdrawal.customer_id)
      .single();

    // ── Handle rejection - refund cashback to customer (atomic) ──
    if (data.status === 'rejected') {
      const currentBalance = customer?.cashback_balance || 0;
      const refundAmount = withdrawal.amount;

      // Use atomic RPC for refund (prevents race condition)
      try {
        await db.rpc('atomic_add_cashback', {
          p_customer_id: withdrawal.customer_id,
          p_amount: refundAmount,
        });
      } catch {
        // RPC may not exist — fallback to direct update
        await db
          .from('customers')
          .update({ cashback_balance: currentBalance + refundAmount })
          .eq('id', withdrawal.customer_id);
      }

      await db.from('cashback_log').insert({
        id: generateId(),
        customer_id: withdrawal.customer_id,
        withdrawal_id: id,
        type: 'admin_adjustment',
        amount: refundAmount,
        balance_before: currentBalance,
        balance_after: currentBalance + refundAmount,
        description: `Pengembalian pencairan ditolak - ${data.rejectionReason || '-'}`,
      });
    }

    // ── Handle processing - deduct from pool + bank/brankas ──
    if (data.status === 'processed') {
      // Validate finance fields
      if (!data.sourceType || !['profit_paid', 'hpp_paid'].includes(data.sourceType)) {
        return NextResponse.json({ error: 'Sumber dana (profit_paid/hpp_paid) wajib dipilih' }, { status: 400 });
      }
      if (!data.destinationType || !['bank_account', 'cash_box'].includes(data.destinationType)) {
        return NextResponse.json({ error: 'Tujuan pencairan (rekening/brankas) wajib dipilih' }, { status: 400 });
      }
      if (data.destinationType === 'bank_account' && !data.bankAccountId) {
        return NextResponse.json({ error: 'Rekening bank wajib dipilih' }, { status: 400 });
      }
      if (data.destinationType === 'cash_box' && !data.cashBoxId) {
        return NextResponse.json({ error: 'Brankas wajib dipilih' }, { status: 400 });
      }

      const amount = withdrawal.amount;

      // Step 1: Atomically deduct from pool balance (prevents double-spend)
      const poolKey = data.sourceType === 'profit_paid' ? 'pool_profit_paid_balance' : 'pool_hpp_paid_balance';
      try {
        await atomicUpdatePoolBalance(poolKey, -amount);
      } catch (poolErr: any) {
        return NextResponse.json(
          { error: `Saldo pool ${data.sourceType === 'profit_paid' ? 'Profit' : 'HPP'} tidak mencukupi` },
          { status: 400 }
        );
      }

      // Step 2: Atomically deduct from bank account or cash box
      try {
        if (data.destinationType === 'bank_account') {
          await atomicUpdateBalance('bank_accounts', data.bankAccountId, -amount);
        } else {
          await atomicUpdateBalance('cash_boxes', data.cashBoxId, -amount);
        }
      } catch (destErr: any) {
        // Rollback: restore pool balance
        try {
          await atomicUpdatePoolBalance(poolKey, amount);
        } catch (rollbackErr) {
          console.error('[CASHBACK WITHDRAWAL] CRITICAL: Failed to rollback pool balance after destination error', rollbackErr);
        }
        const destLabel = data.destinationType === 'bank_account' ? 'rekening bank' : 'brankas';
        return NextResponse.json(
          { error: `Saldo ${destLabel} tidak mencukupi (pool sudah dikembalikan)` },
          { status: 400 }
        );
      }
    }

    // Update withdrawal status
    const updateData: any = {
      status: data.status,
      processed_by_id: authUserId.userId,
      processed_at: new Date().toISOString(),
    };

    if (data.status === 'rejected' && data.rejectionReason) {
      updateData.rejection_reason = data.rejectionReason;
    }
    if (data.notes) {
      updateData.notes = data.notes;
    }
    // Store finance fields on processed
    if (data.status === 'processed') {
      updateData.source_type = data.sourceType;
      updateData.bank_account_id = data.bankAccountId || null;
      updateData.cash_box_id = data.cashBoxId || null;
    }

    const { data: updated } = await db
      .from('cashback_withdrawal')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (!updated) {
      console.error('Withdrawal update error: no data returned');
      return NextResponse.json({ error: 'Gagal memperbarui pencairan' }, { status: 500 });
    }

    // Create event
    createEvent(db, 'cashback_withdrawal_' + data.status, {
      withdrawalId: id,
      customerName: customer?.name,
      amount: withdrawal.amount,
      status: data.status,
      processedBy: authUserId.user.name,
      sourceType: data.sourceType || null,
      destinationType: data.destinationType || null,
      rejectionReason: data.rejectionReason || null,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      withdrawal: {
        ...toCamelCase(updated),
        customer: customer ? toCamelCase(customer) : null,
      },
    });
  } catch (error) {
    console.error('Cashback withdrawal PATCH error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
