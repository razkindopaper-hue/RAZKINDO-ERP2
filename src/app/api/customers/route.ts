import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, generateId } from '@/lib/supabase-helpers';
import { verifyAuthUser } from '@/lib/token';
import { wsCustomerUpdate } from '@/lib/ws-dispatch';
import { validateBody, validateQuery, customerSchemas, commonSchemas } from '@/lib/validators';

/**
 * Generate a unique customer PWA code.
 * Format: CUST + 4-digit sequential number (e.g., CUST0001)
 * Checks for uniqueness against the database.
 */
async function generateCustomerCode(): Promise<string> {
  // Find the highest existing CUST code number
  const { data: existingCodes } = await db
    .from('customers')
    .select('code')
    .like('code', 'CUST%')
    .order('code', { ascending: false })
    .limit(1);

  let nextNum = 1;
  if (existingCodes && existingCodes.length > 0 && existingCodes[0].code) {
    const match = existingCodes[0].code.match(/CUST(\d+)/);
    if (match) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }

  // Try up to 10 times in case of race condition
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `CUST${String(nextNum).padStart(4, '0')}`;
    // Verify uniqueness
    const { data: conflict } = await db
      .from('customers')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    if (!conflict) return code;
    nextNum++;
  }

  // Fallback: use timestamp-based code
  return `CUST${Date.now().toString(36).toUpperCase()}`;
}

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch user role for filtering
    const { data: authUser } = await db
      .from('users')
      .select('role')
      .eq('id', authUserId)
      .single();

    const { searchParams } = new URL(request.url);
    const queryValidation = validateQuery(commonSchemas.pagination, searchParams);
    if (!queryValidation.success) {
      return NextResponse.json({ error: queryValidation.error }, { status: 400 });
    }
    const unitId = searchParams.get('unitId');
    const assignedToId = searchParams.get('assignedToId');
    const status = searchParams.get('status');

    let query = db
      .from('customers')
      .select(`
        *,
        unit:units(*),
        assigned_to:users!assigned_to_id(id, name, email)
      `);

    if (unitId) query = query.eq('unit_id', unitId);
    // Sales users can only see their own assigned customers
    if (authUser?.role === 'sales') {
      query = query.eq('assigned_to_id', authUserId);
    } else {
      if (assignedToId) query = query.eq('assigned_to_id', assignedToId);
    }
    if (status) {
      query = query.eq('status', status);
    } else {
      // By default, exclude lost/inactive customers unless specifically requested
      query = query.neq('status', 'lost');
    }

    const { data: customers } = await query
      .order('name', { ascending: true })
      .limit(100);

    // Map snake_case to camelCase and remap the assigned_to key to assignedTo
    const customersCamel = (customers || []).map((c: any) => {
      const camel = toCamelCase(c);
      return {
        ...camel,
        assignedTo: camel.assignedTo || null
      };
    });

    return NextResponse.json({ customers: customersCamel });
  } catch (error) {
    console.error('Get customers error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Role check: only super_admin and sales can create customers
    const { data: authUser } = await db
      .from('users')
      .select('role')
      .eq('id', authUserId)
      .single();
    if (!authUser || (authUser.role !== 'super_admin' && authUser.role !== 'sales')) {
      return NextResponse.json({ error: 'Hanya super admin dan sales yang bisa menambah pelanggan' }, { status: 403 });
    }

    const rawBody = await request.json();
    const validation = validateBody(customerSchemas.create, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const data = validation.data;

    // ========== DUPLICATE CHECK ==========
    // Check by name within same unit
    let dupQuery = db
      .from('customers')
      .select('id, name, phone, assigned_to:users!assigned_to_id(id, name)')
      .eq('unit_id', data.unitId)
      .eq('name', data.name.trim())
      .neq('status', 'inactive');

    // If phone provided, also match by phone
    if (data.phone && data.phone.trim()) {
      // Check name OR phone match
      const { data: dupByName } = await dupQuery;
      const { data: dupByPhone } = await db
        .from('customers')
        .select('id, name, phone, assigned_to:users!assigned_to_id(id, name)')
        .eq('unit_id', data.unitId)
        .eq('phone', data.phone.trim())
        .neq('status', 'inactive');

      const dups = [...(dupByName || []), ...(dupByPhone || [])];
      // Deduplicate by id
      const seen = new Set<string>();
      const uniqueDups = dups.filter((d: any) => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      });

      if (uniqueDups.length > 0) {
        const dup = toCamelCase(uniqueDups[0]);
        const salesName = dup.assignedTo?.name || 'Tidak ada sales';
        return NextResponse.json(
          {
            error: `Pelanggan "${data.name.trim()}" sudah diinput oleh ${salesName}`,
            duplicate: {
              id: dup.id,
              name: dup.name,
              phone: dup.phone,
              assignedTo: dup.assignedTo || null
            }
          },
          { status: 409 }
        );
      }
    } else {
      // No phone — check name only
      const { data: dupByName } = await dupQuery;
      if (dupByName && dupByName.length > 0) {
        const dup = toCamelCase(dupByName[0]);
        const salesName = dup.assignedTo?.name || 'Tidak ada sales';
        return NextResponse.json(
          {
            error: `Pelanggan "${data.name.trim()}" sudah diinput oleh ${salesName}`,
            duplicate: {
              id: dup.id,
              name: dup.name,
              phone: dup.phone,
              assignedTo: dup.assignedTo || null
            }
          },
          { status: 409 }
        );
      }
    }
    // ========== END DUPLICATE CHECK ==========

    // Auto-generate PWA code for the new customer
    const pwaCode = await generateCustomerCode();

    const { data: customer, error: insertError } = await db
      .from('customers')
      .insert({
        id: generateId(),
        name: data.name,
        phone: data.phone,
        email: data.email,
        address: data.address,
        unit_id: data.unitId,
        notes: data.notes,
        distance: data.distance || 'near',
        assigned_to_id: data.assignedToId || null,
        code: pwaCode,
        cashback_type: data.cashbackType || 'percentage',
        cashback_value: data.cashbackValue || 0,
        updated_at: new Date().toISOString(),
      })
      .select(`
        *,
        unit:units(*),
        assigned_to:users!assigned_to_id(id, name, email)
      `)
      .single();

    if (insertError) {
      console.error('Customer insert error:', insertError);
      return NextResponse.json(
        { error: 'Gagal menambahkan pelanggan: ' + insertError.message },
        { status: 500 }
      );
    }

    const customerCamel = toCamelCase(customer);
    wsCustomerUpdate({ unitId: data.unitId });
    return NextResponse.json({ customer: { ...customerCamel, assignedTo: customerCamel.assignedTo || null } });
  } catch (error) {
    console.error('Create customer error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
