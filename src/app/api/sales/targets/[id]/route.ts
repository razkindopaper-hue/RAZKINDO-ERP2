import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';

function toCamelCase(row: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

function formatTarget(t: any) {
  const ct = typeof t.user_id !== 'undefined' ? toCamelCase(t) : t;
  return {
    id: ct.id,
    userId: ct.userId,
    period: ct.period,
    year: ct.year,
    month: ct.month,
    quarter: ct.quarter,
    targetAmount: Number(ct.targetAmount) || 0,
    achievedAmount: Number(ct.achievedAmount) || 0,
    status: ct.status,
    notes: ct.notes,
    createdAt: ct.createdAt,
    updatedAt: ct.updatedAt,
    user: ct.userName ? { name: ct.userName, email: ct.userEmail } : null,
  };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Akses ditolak' }, { status: 401 });

    const { data: authUser } = await db.from('users').select('id, role').eq('id', authUserId).single();
    if (!authUser || !['super_admin', 'admin', 'keuangan'].includes(authUser.role)) {
      return NextResponse.json({ error: 'Hanya super_admin, admin, atau keuangan yang dapat mengubah target' }, { status: 403 });
    }

    const { id } = await params;
    const data = await request.json();

    // Check target exists
    const { data: existing } = await db.from('sales_targets').select('*').eq('id', id).maybeSingle();
    if (!existing) return NextResponse.json({ error: 'Target penjualan tidak ditemukan' }, { status: 404 });
    if (existing.status === 'expired') return NextResponse.json({ error: 'Target yang sudah expired tidak dapat diubah' }, { status: 400 });

    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (data.targetAmount !== undefined) {
      if (typeof data.targetAmount !== 'number' || data.targetAmount <= 0) return NextResponse.json({ error: 'targetAmount harus berupa angka dan lebih dari 0' }, { status: 400 });
      updateData.target_amount = data.targetAmount;
    }
    if (data.status !== undefined) {
      const validStatuses = ['active', 'completed', 'expired'];
      if (!validStatuses.includes(data.status)) return NextResponse.json({ error: 'Status harus salah satu dari: active, completed, expired' }, { status: 400 });
      updateData.status = data.status;
    }
    if (data.achievedAmount !== undefined) {
      if (typeof data.achievedAmount !== 'number' || data.achievedAmount < 0) return NextResponse.json({ error: 'achievedAmount harus berupa angka dan tidak kurang dari 0' }, { status: 400 });
      updateData.achieved_amount = data.achievedAmount;
    }
    if (data.notes !== undefined) updateData.notes = data.notes;

    const { data: updated, error } = await db
      .from('sales_targets')
      .update(updateData)
      .eq('id', id)
      .select('*, user:users!user_id(name, email)')
      .single();
    if (error) throw error;

    return NextResponse.json({ target: formatTarget(updated) });
  } catch (error) {
    console.error('Update sales target error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Akses ditolak' }, { status: 401 });

    const { data: authUser } = await db.from('users').select('id, role').eq('id', authUserId).single();
    if (!authUser || authUser.role !== 'super_admin') {
      return NextResponse.json({ error: 'Hanya super_admin yang dapat menghapus target' }, { status: 403 });
    }

    const { id } = await params;

    const { data: existing } = await db.from('sales_targets').select('status').eq('id', id).maybeSingle();
    if (!existing) return NextResponse.json({ error: 'Target penjualan tidak ditemukan' }, { status: 404 });
    if (existing.status !== 'active') return NextResponse.json({ error: 'Hanya target dengan status active yang dapat dihapus' }, { status: 400 });

    const { error } = await db.from('sales_targets').delete().eq('id', id);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete sales target error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
