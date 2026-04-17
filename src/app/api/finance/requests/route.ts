import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';
import { rowsToCamelCase, toSnakeCase, createLog, createEvent, toCamelCase, generateId } from '@/lib/supabase-helpers';
import { enforceFinanceRole } from '@/lib/require-auth';
import { validateBody, validateQuery, financeRequestSchemas } from '@/lib/validators';

export async function GET(request: NextRequest) {
  try {
    const authResult = await enforceFinanceRole(request);
    if (!authResult.success) return authResult.response;

    const { searchParams } = new URL(request.url);
    const queryValidation = validateQuery(financeRequestSchemas.query, searchParams);
    if (!queryValidation.success) {
      return NextResponse.json({ error: queryValidation.error }, { status: 400 });
    }
    const type = searchParams.get('type');
    const status = searchParams.get('status');

    let query = db.from('finance_requests').select(`
      *,
      supplier:suppliers(id, name, phone),
      transaction:transactions(id, invoice_no, customer:customers(id, name), unit:units(id, name)),
      bank_account:bank_accounts(id, name, bank_name, account_no),
      cash_box:cash_boxes(id, name),
      salary_payment:salary_payments(id, user_id, user:users!user_id(id, name))
    `).order('created_at', { ascending: false }).limit(500);

    if (type) query = query.eq('type', type);
    if (status) query = query.eq('status', status);

    const { data: requests, error } = await query;
    if (error) throw error;

    return NextResponse.json({ requests: rowsToCamelCase(requests || []) });
  } catch (error) {
    console.error('Get finance requests error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // BUG FIX #11: Verify user role before allowing finance request creation
    const { data: authUserData } = await db
      .from('users')
      .select('role, is_active, status')
      .eq('id', authUserId)
      .single();
    if (!authUserData?.is_active || authUserData.status !== 'approved') {
      return NextResponse.json({ error: 'Akses ditolak' }, { status: 403 });
    }
    const allowedRoles = ['super_admin', 'keuangan', 'sales'];
    if (!allowedRoles.includes(authUserData.role)) {
      return NextResponse.json({ error: 'Role tidak memiliki akses untuk membuat request keuangan' }, { status: 403 });
    }

    const rawBody = await request.json();

    // Pre-process: convert empty strings to undefined for optional UUID fields
    const preProcessed = {
      ...rawBody,
      unitId: rawBody.unitId || undefined,
      supplierId: rawBody.supplierId || undefined,
      transactionId: rawBody.transactionId || undefined,
      courierId: rawBody.courierId || undefined,
    };
    const validation = validateBody(financeRequestSchemas.create, preProcessed);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const data = validation.data;

    // Security: Override requestById with authenticated user ID to prevent impersonation
    const requestById = authUserId;

    const insertData = toSnakeCase({
      id: generateId(), type: data.type,
      requestById,
      unitId: data.unitId,
      amount: data.amount,
      description: data.description,
      supplierId: data.supplierId,
      purchaseItems: typeof data.purchaseItems === 'string' ? data.purchaseItems : JSON.stringify(data.purchaseItems || {}),
      transactionId: data.transactionId,
      courierId: data.courierId,
      notes: data.notes,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    });

    const { data: financeRequest, error } = await db.from('finance_requests').insert(insertData).select().single();
    if (error) throw error;

    createEvent(db, 'finance_request_created', { requestId: financeRequest.id, type: data.type, amount: data.amount, description: data.description });
    createLog(db, { type: 'activity', userId: requestById, action: 'finance_request_created', entity: 'finance_request', entityId: financeRequest.id, message: `Request ${data.type} sebesar ${data.amount} dibuat` });

    return NextResponse.json({ request: toCamelCase(financeRequest) });
  } catch (error) {
    console.error('Create finance request error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
