import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';

function formatTarget(t: any) {
  return {
    id: t.id,
    userId: t.userId,
    period: t.period,
    year: t.year,
    month: t.month,
    quarter: t.quarter,
    targetAmount: t.targetAmount,
    achievedAmount: t.achievedAmount,
    status: t.status,
    notes: t.notes,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    user: t.user ? { name: t.user.name, email: t.user.email } : null,
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

    const existing = await prisma.salesTarget.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Target penjualan tidak ditemukan' }, { status: 404 });
    if (existing.status === 'expired') return NextResponse.json({ error: 'Target yang sudah expired tidak dapat diubah' }, { status: 400 });

    const updateData: any = {};
    if (data.targetAmount !== undefined) {
      if (typeof data.targetAmount !== 'number' || data.targetAmount <= 0) return NextResponse.json({ error: 'targetAmount harus berupa angka dan lebih dari 0' }, { status: 400 });
      updateData.targetAmount = data.targetAmount;
    }
    if (data.status !== undefined) {
      const validStatuses = ['active', 'completed', 'expired'];
      if (!validStatuses.includes(data.status)) return NextResponse.json({ error: 'Status harus salah satu dari: active, completed, expired' }, { status: 400 });
      updateData.status = data.status;
    }
    if (data.achievedAmount !== undefined) {
      if (typeof data.achievedAmount !== 'number' || data.achievedAmount < 0) return NextResponse.json({ error: 'achievedAmount harus berupa angka dan tidak kurang dari 0' }, { status: 400 });
      updateData.achievedAmount = data.achievedAmount;
    }
    if (data.notes !== undefined) updateData.notes = data.notes;

    const target = await prisma.salesTarget.update({
      where: { id },
      data: updateData,
      include: { user: { select: { name: true, email: true } } },
    });

    return NextResponse.json({ target: formatTarget(target) });
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

    const existing = await prisma.salesTarget.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Target penjualan tidak ditemukan' }, { status: 404 });
    if (existing.status !== 'active') return NextResponse.json({ error: 'Hanya target dengan status active yang dapat dihapus' }, { status: 400 });

    await prisma.salesTarget.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete sales target error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
