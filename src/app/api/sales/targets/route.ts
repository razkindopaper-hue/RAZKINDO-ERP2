import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { generateId } from '@/lib/supabase-helpers';

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

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Akses ditolak' }, { status: 401 });

    const { data: authUser } = await db.from('users').select('id, role').eq('id', authUserId).single();
    if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const filterUserId = searchParams.get('userId');
    const year = searchParams.get('year');
    const period = searchParams.get('period');

    let query = db
      .from('sales_targets')
      .select('*, user:users!user_id(name, email)')
      .order('year', { ascending: false })
      .order('created_at', { ascending: false });

    // Non-super_admin can only see own targets
    if (authUser.role !== 'super_admin') {
      query = query.eq('user_id', authUserId);
    }
    if (filterUserId) {
      query = query.eq('user_id', filterUserId);
    }
    if (year) {
      const parsedYear = parseInt(year, 10);
      if (isNaN(parsedYear)) return NextResponse.json({ error: 'Year harus berupa angka' }, { status: 400 });
      query = query.eq('year', parsedYear);
    }
    if (period) {
      query = query.eq('period', period);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Flatten user relation into camelCase
    const result = (data || []).map((t: any) => {
      const ct = toCamelCase(t);
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
        user: ct.user ? { name: ct.user.name, email: ct.user.email } : null,
      };
    });

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
    const { data: user } = await db.from('users').select('id, role').eq('id', userId).single();
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

    // Check existing target (unique: userId + period + year + month + quarter)
    const { data: existing } = await db
      .from('sales_targets')
      .select('id')
      .eq('user_id', userId)
      .eq('period', period)
      .eq('year', year)
      .eq('month', finalMonth)
      .eq('quarter', finalQuarter)
      .maybeSingle();

    if (existing) {
      // Update existing
      const { data: updated, error: updateError } = await db
        .from('sales_targets')
        .update({
          target_amount: targetAmount,
          notes: notes || null,
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*, user:users!user_id(name, email)')
        .single();
      if (updateError) throw updateError;
      return NextResponse.json({ target: formatTarget(updated) });
    }

    // Create new
    const now = new Date().toISOString();
    const { data: created, error: createError } = await db
      .from('sales_targets')
      .insert({
        id: generateId(),
        user_id: userId,
        period,
        year,
        month: finalMonth,
        quarter: finalQuarter,
        target_amount: targetAmount,
        achieved_amount: 0,
        status: 'active',
        notes: notes || null,
        created_at: now,
        updated_at: now,
      })
      .select('*, user:users!user_id(name, email)')
      .single();
    if (createError) throw createError;

    return NextResponse.json({ target: formatTarget(created) });
  } catch (error) {
    console.error('Create sales target error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
