import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, createLog } from '@/lib/supabase-helpers';
import { verifyAndGetAuthUser } from '@/lib/token';
import { wsCustomerUpdate } from '@/lib/ws-dispatch';

// =====================================================================
// POST /api/customers/[id]/assign
// Super Admin only: Reassign a customer to a different sales person
// =====================================================================
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Verify auth + role
    const result = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true, name: true }
    );
    if (!result) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (result.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden — hanya super admin yang bisa mengalihkan pelanggan' }, { status: 403 });
    }

    const { user: authUser } = result;
    const { id } = await params;
    const data = await request.json();
    const { assignedToId } = data;

    if (assignedToId === undefined || typeof assignedToId !== 'string') {
      return NextResponse.json({ error: 'assignedToId wajib diisi (string)' }, { status: 400 });
    }

    // Fetch existing customer with current assignment
    const { data: existing } = await db
      .from('customers')
      .select(`
        *,
        assigned_to:users!assigned_to_id(id, name),
        unit:units(id, name)
      `)
      .eq('id', id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Pelanggan tidak ditemukan' }, { status: 404 });
    }
    const existingCamel = toCamelCase(existing);

    // Skip if no change
    const newAssignedToId = assignedToId === '' ? null : assignedToId;
    if (existingCamel.assignedToId === newAssignedToId) {
      return NextResponse.json({ error: 'Tidak ada perubahan — sales tujuan sama dengan saat ini' }, { status: 400 });
    }

    // Validate target user (must be sales or super_admin)
    let targetUserName = 'Tidak ada';
    if (newAssignedToId) {
      const { data: targetUser } = await db
        .from('users')
        .select('id, name, role, status, is_active')
        .eq('id', newAssignedToId)
        .maybeSingle();

      if (!targetUser) {
        return NextResponse.json({ error: 'User tujuan tidak ditemukan' }, { status: 404 });
      }
      const target = toCamelCase(targetUser);
      if (target.role !== 'sales' && target.role !== 'super_admin') {
        return NextResponse.json({ error: 'Target user bukan sales/super admin' }, { status: 400 });
      }
      if (target.status !== 'approved' || !target.isActive) {
        return NextResponse.json({ error: 'User tujuan tidak aktif' }, { status: 400 });
      }
      targetUserName = target.name;
    }

    // Update customer
    const { data: customer } = await db
      .from('customers')
      .update({ assigned_to_id: newAssignedToId })
      .eq('id', id)
      .select(`
        *,
        unit:units(*),
        assigned_to:users!assigned_to_id(id, name, email)
      `)
      .single();

    const customerCamel = toCamelCase(customer);

    const oldSalesName = existingCamel.assignedTo?.name || 'Tidak ada';

    // Create audit log
    createLog(db, {
      type: 'audit',
      userId: result.userId,
      action: 'customer_assigned_by_superadmin',
      entity: 'Customer',
      entityId: id,
      payload: JSON.stringify({
        oldAssignedToId: existingCamel.assignedToId,
        newAssignedToId: newAssignedToId,
        oldSalesName,
        newSalesName: targetUserName,
        performedBy: authUser.name,
      }),
      message: `SUPERADMIN (${authUser.name}): Pelanggan ${customerCamel.name} dialihkan dari ${oldSalesName} ke ${targetUserName}`
    });

    // Dispatch WebSocket event
    wsCustomerUpdate({ unitId: customerCamel.unitId });

    return NextResponse.json({
      success: true,
      customer: { ...customerCamel, assignedTo: customerCamel.assignedTo || null },
      message: `${customerCamel.name} berhasil dialihkan dari ${oldSalesName} ke ${targetUserName}`
    });
  } catch (error) {
    console.error('[CUSTOMER_ASSIGN] Error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
