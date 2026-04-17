import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { rowsToCamelCase, toSnakeCase, createLog, createEvent, toCamelCase as toCamel, generateId } from '@/lib/supabase-helpers';
import { enforceFinanceRole } from '@/lib/require-auth';

export async function GET(request: NextRequest) {
  try {
    const authResult = await enforceFinanceRole(request);
    if (!authResult.success) return authResult.response;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const status = searchParams.get('status');
    const period = searchParams.get('period');

    let query = db.from('salary_payments').select(`
      *, user:users!user_id(id, name, email, role), finance_request:finance_requests(id, type, amount, status)
    `).order('created_at', { ascending: false }).limit(500);

    if (userId) query = query.eq('user_id', userId);
    if (status) query = query.eq('status', status);
    if (period) {
      const [start, end] = period.split(',');
      if (start && end) query = query.gte('period_start', new Date(start).toISOString()).lte('period_end', new Date(end).toISOString());
    }

    const { data: salaries, error } = await query;
    if (error) throw error;

    const mapped = rowsToCamelCase(salaries || []);
    const stats = {
      totalPaid: mapped.filter((s: any) => s.status === 'paid').reduce((sum: number, s: any) => sum + (s.totalAmount || 0), 0),
      totalPending: mapped.filter((s: any) => s.status === 'pending').reduce((sum: number, s: any) => sum + (s.totalAmount || 0), 0),
      totalApproved: mapped.filter((s: any) => s.status === 'approved').reduce((sum: number, s: any) => sum + (s.totalAmount || 0), 0),
      paidCount: mapped.filter((s: any) => s.status === 'paid').length,
      pendingCount: mapped.filter((s: any) => s.status === 'pending').length,
    };

    return NextResponse.json({ salaries: mapped, stats });
  } catch (error) {
    console.error('Get salaries error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only super_admin or keuangan can create salary entries
    const { data: authUser } = await db.from('users').select('role, is_active, status').eq('id', authUserId).single();
    if (!authUser || !authUser.is_active || authUser.status !== 'approved') {
      return NextResponse.json({ error: 'Akses ditolak' }, { status: 403 });
    }
    if (!['super_admin', 'keuangan'].includes(authUser.role)) {
      return NextResponse.json({ error: 'Hanya Super Admin atau Keuangan yang dapat membuat slip gaji' }, { status: 403 });
    }

    const data = await request.json();

    if (!data.userId) return NextResponse.json({ error: 'ID karyawan wajib diisi' }, { status: 400 });
    if (!data.baseSalary || data.baseSalary <= 0) return NextResponse.json({ error: 'Gaji pokok harus lebih dari 0' }, { status: 400 });
    if (!data.periodStart || !data.periodEnd) return NextResponse.json({ error: 'Periode gaji wajib diisi' }, { status: 400 });

    const totalAllowance = (data.transportAllowance || 0) + (data.mealAllowance || 0) + (data.overtimePay || 0) + (data.incentive || 0) + (data.otherAllowance || 0) + (data.bonus || 0);
    const totalDeduction = (data.bpjsTk || 0) + (data.bpjsKs || 0) + (data.pph21 || 0) + (data.loanDeduction || 0) + (data.absenceDeduction || 0) + (data.lateDeduction || 0) + (data.otherDeduction || 0) + (data.deduction || 0);
    const totalAmount = Math.max(0, data.baseSalary + totalAllowance - totalDeduction);

    const { data: userData } = await db.from('users').select('name').eq('id', data.userId).maybeSingle();
    const periodDesc = `Periode ${data.periodStart} s/d ${data.periodEnd}`;
    const description = `Gaji ${userData?.name || 'Karyawan'} - ${periodDesc}`;

    // Security: Use authenticated user ID for the finance request (prevent impersonation)
    const requestById = authUserId;

    const frData = toSnakeCase({
      id: generateId(), type: 'salary', requestById, unitId: data.unitId,
      amount: totalAmount, description, notes: data.notes, status: 'pending',
      updatedAt: new Date().toISOString(),
    });
    const { data: financeRequest, error: frError } = await db.from('finance_requests').insert(frData).select().single();
    if (frError) throw frError;

    // Create SalaryPayment
    const salaryData = toSnakeCase({
      id: generateId(), userId: data.userId, periodStart: new Date(data.periodStart).toISOString(), periodEnd: new Date(data.periodEnd).toISOString(),
      baseSalary: data.baseSalary, transportAllowance: data.transportAllowance || 0, mealAllowance: data.mealAllowance || 0,
      overtimePay: data.overtimePay || 0, incentive: data.incentive || 0, otherAllowance: data.otherAllowance || 0, bonus: data.bonus || 0,
      bpjsTk: data.bpjsTk || 0, bpjsKs: data.bpjsKs || 0, pph21: data.pph21 || 0,
      loanDeduction: data.loanDeduction || 0, absenceDeduction: data.absenceDeduction || 0, lateDeduction: data.lateDeduction || 0,
      otherDeduction: data.otherDeduction || 0, deduction: data.deduction || 0,
      totalAllowance, totalDeduction, totalAmount, financeRequestId: financeRequest.id, notes: data.notes,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    });
    const { data: salary, error: sError } = await db.from('salary_payments').insert(salaryData).select(`
      *, user:users!user_id(id, name, email, role), finance_request:finance_requests(id, type, amount, status)
    `).single();
    if (sError) throw sError;

    createEvent(db, 'salary_request_created', { salaryId: salary.id, requestId: financeRequest.id, userId: data.userId, userName: userData?.name, amount: totalAmount, period: periodDesc });
    createLog(db, { type: 'activity', userId: requestById, action: 'salary_created', entity: 'salary', entityId: salary.id, payload: JSON.stringify({ userId: data.userId, amount: totalAmount, financeRequestId: financeRequest.id }), message: `Slip gaji dibuat untuk ${userData?.name}: ${totalAmount}` });

    return NextResponse.json({ salary: toCamel(salary) });
  } catch (error) {
    console.error('Create salary error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
