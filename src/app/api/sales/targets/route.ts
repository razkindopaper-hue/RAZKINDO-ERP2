import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Akses ditolak' }, { status: 401 });

    const { data: authUser } = await db.from('users').select('id, role').eq('id', authUserId).single();
    if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const year = searchParams.get('year');
    const period = searchParams.get('period');

    const where: any = {};
    if (authUser.role !== 'super_admin') where.userId = authUserId;
    if (userId) where.userId = userId;
    if (year) {
      const parsedYear = parseInt(year, 10);
      if (isNaN(parsedYear)) return NextResponse.json({ error: 'Year harus berupa angka' }, { status: 400 });
      where.year = parsedYear;
    }
    if (period) where.period = period;

    const targets = await prisma.salesTarget.findMany({
      where,
      include: { user: { select: { name: true, email: true } } },
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
    });

    // Convert to camelCase for frontend
    const result = targets.map(t => ({
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
    }));

    return NextResponse.json({ targets: result });
  } catch (error) {
    console.error('Get sales targets error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Akses ditolak' }, { status: 401 });

    const data = await request.json();
    const { userId, period, year, month, quarter, targetAmount, notes } = data;

    if (!userId || !period || !year || !targetAmount) {
      return NextResponse.json({ error: 'Field userId, period, year, dan targetAmount wajib diisi' }, { status: 400 });
    }
    const validPeriods = ['monthly', 'quarterly', 'yearly'];
    if (!validPeriods.includes(period)) return NextResponse.json({ error: 'Period harus salah satu dari: monthly, quarterly, yearly' }, { status: 400 });
    if (typeof targetAmount !== 'number' || targetAmount <= 0) return NextResponse.json({ error: 'targetAmount harus berupa angka dan lebih dari 0' }, { status: 400 });

    // Verify user exists and has valid role
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) return NextResponse.json({ error: 'User tidak ditemukan' }, { status: 404 });
    if (!['sales', 'admin', 'super_admin', 'keuangan'].includes(user.role)) {
      return NextResponse.json({ error: 'Target penjualan hanya dapat diberikan kepada user dengan role sales, admin, super_admin, atau keuangan' }, { status: 400 });
    }

    if (period === 'monthly' && (month === undefined || month === null)) return NextResponse.json({ error: 'Field month wajib diisi untuk period monthly' }, { status: 400 });
    if (period === 'quarterly' && (quarter === undefined || quarter === null)) return NextResponse.json({ error: 'Field quarter wajib diisi untuk period quarterly' }, { status: 400 });
    if (period === 'monthly' && (month < 1 || month > 12)) return NextResponse.json({ error: 'Field month harus bernilai 1-12' }, { status: 400 });
    if (period === 'quarterly' && (quarter < 1 || quarter > 4)) return NextResponse.json({ error: 'Field quarter harus bernilai 1-4' }, { status: 400 });

    const finalMonth = period === 'monthly' ? (month || 0) : 0;
    const finalQuarter = period === 'quarterly' ? (quarter || 0) : 0;

    // Check existing target (upsert via unique constraint)
    const existing = await prisma.salesTarget.findFirst({
      where: { userId, period, year, month: finalMonth, quarter: finalQuarter },
    });

    if (existing) {
      const target = await prisma.salesTarget.update({
        where: { id: existing.id },
        data: { targetAmount, notes: notes ?? undefined, status: 'active' },
        include: { user: { select: { name: true, email: true } } },
      });
      return NextResponse.json({ target: formatTarget(target) });
    }

    const target = await prisma.salesTarget.create({
      data: {
        userId,
        period,
        year,
        month: finalMonth,
        quarter: finalQuarter,
        targetAmount,
        achievedAmount: 0,
        status: 'active',
        notes: notes ?? null,
      },
      include: { user: { select: { name: true, email: true } } },
    });

    return NextResponse.json({ target: formatTarget(target) });
  } catch (error) {
    console.error('Create sales target error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

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
