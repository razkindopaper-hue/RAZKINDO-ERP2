import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { createLog, createEvent, generateId } from '@/lib/supabase-helpers';
import { wsFinanceUpdate, wsCourierUpdate } from '@/lib/ws-dispatch';
import { atomicUpdatePoolBalance } from '@/lib/atomic-ops';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Authorization: only kurir (own), super_admin, and keuangan can view handovers
    const { data: authUser } = await db
      .from('users')
      .select('role, is_active, status')
      .eq('id', authUserId)
      .single();
    if (!authUser?.is_active || authUser.status !== 'approved') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (authUser.role !== 'kurir' && authUser.role !== 'super_admin' && authUser.role !== 'keuangan') {
      return NextResponse.json({ error: 'Akses ditolak' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const courierId = searchParams.get('courierId');
    if (!courierId) return NextResponse.json({ error: 'courierId diperlukan' }, { status: 400 });

    // Kurir can only view their own handovers
    if (authUser.role === 'kurir' && authUserId !== courierId) {
      return NextResponse.json({ error: 'Kurir hanya bisa melihat handover sendiri' }, { status: 403 });
    }

    const { data: courierCashList, error } = await db.from('courier_cash').select(`
      *, unit:units(id, name), handovers:courier_handovers(*)
    `).eq('courier_id', courierId);
    if (error) throw error;

    const totalBalance = (courierCashList || []).reduce((sum: number, cc: any) => sum + cc.balance, 0);

    return NextResponse.json({
      courierCashList,
      totalBalance,
      totalCollected: (courierCashList || []).reduce((sum: number, cc: any) => sum + cc.total_collected, 0),
      totalHandover: (courierCashList || []).reduce((sum: number, cc: any) => sum + cc.total_handover, 0),
    });
  } catch (error) {
    console.error('Get courier cash error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const data = await request.json();
    const { courierId, unitId, amount, notes } = data;
    if (!courierId || !unitId || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'courierId, unitId, dan amount (angka positif) diperlukan' }, { status: 400 });
    }

    const { data: authUser } = await db.from('users').select('role').eq('id', authUserId).single();
    if (!authUser || (authUser.role !== 'kurir' && authUser.role !== 'super_admin')) {
      return NextResponse.json({ error: 'Akses ditolak - Hanya kurir atau super admin' }, { status: 403 });
    }

    // Courier can only handover for their own ID
    if (authUser.role === 'kurir' && authUserId !== courierId) {
      return NextResponse.json({ error: 'Kurir hanya bisa melakukan handover untuk diri sendiri' }, { status: 403 });
    }

    // ── ATOMIC HANDOVER: Single RPC call handles everything in one DB transaction ──
    // This replaces the previous non-atomic multi-step approach that could leave
    // inconsistent data (e.g., courier cash deducted but handover record not created).
    //
    // The RPC process_courier_handover atomically:
    // 1. Gets or creates courier_cash record
    // 2. Validates sufficient balance
    // 3. Deducts from courier_cash balance
    // 4. Gets or creates brankas (cash_box)
    // 5. Credits brankas balance
    // 6. Creates finance_request
    // 7. Creates courier_handover record
    // 8. Returns all results as JSONB
    const { data: result, error: rpcError } = await db.rpc('process_courier_handover', {
      p_courier_id: courierId,
      p_unit_id: unitId,
      p_amount: amount,
      p_processed_by_id: authUserId,
      p_notes: notes || null,
    });

    if (rpcError) {
      const errMsg = rpcError.message || 'Gagal mengurangi saldo courier cash';
      console.error('[HANDOVER] RPC error:', errMsg);
      if (errMsg.includes('tidak cukup') || errMsg.includes('insufficient')) {
        return NextResponse.json({ 
          error: `Saldo cash tidak cukup untuk melakukan handover sebesar ${formatCurrency(amount)}` 
        }, { status: 400 });
      }
      throw new Error(errMsg);
    }

    if (!result) {
      throw new Error('Gagal mengurangi saldo courier cash — tidak ada respons dari server');
    }

    const handoverId = result.handover_id;
    const financeRequestId = result.finance_request_id;
    const cashBoxId = result.cash_box_id;
    const newBalance = Number(result.new_balance) || 0;
    const brankasBalance = Number(result.cash_box_balance) || 0;

    // Get courier name for logging
    const { data: courier } = await db.from('users').select('name').eq('id', courierId).single();

    createLog(db, {
      type: 'activity', userId: courierId, action: 'courier_cash_handover', entity: 'courier_handover', entityId: handoverId,
      payload: JSON.stringify({ amount, financeRequestId, cashBoxId, courierNewBalance: newBalance, brankasNewBalance: brankasBalance }),
      message: `Kurir ${courier?.name || 'Unknown'} menyetor ${formatCurrency(amount)} ke brankas`,
    });

    createEvent(db, 'courier_handover', {
      handoverId, courierId, courierName: courier?.name || 'Unknown',
      amount, financeRequestId, cashBoxId, unitId,
      updatedBalance: newBalance, brankasBalance,
    });

    wsFinanceUpdate({ type: 'courier_handover', unitId });
    wsCourierUpdate({ courierId });

    return NextResponse.json({
      handoverId,
      financeRequestId,
      cashBoxId,
      updatedBalance: newBalance,
      brankasBalance,
    });
  } catch (error) {
    console.error('Create handover error:', error);
    const message = error instanceof Error ? error.message : 'Terjadi kesalahan server';
    const isValidationError = message.includes('tidak cukup') || message.includes('harus') || message.includes('wajib') || message.includes('valid');
    return NextResponse.json({ error: message }, { status: isValidationError ? 400 : 500 });
  }
}
