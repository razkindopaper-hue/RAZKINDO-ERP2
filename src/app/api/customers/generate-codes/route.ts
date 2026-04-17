import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAuthUser } from '@/lib/token';

// =====================================================================
// POST /api/customers/generate-codes
// Batch-generate PWA codes for all customers without codes.
// Only super_admin can trigger this.
// =====================================================================

/**
 * Generate a unique customer PWA code (same logic as in customers/route.ts)
 */
async function generateCustomerCode(): Promise<string> {
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

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `CUST${String(nextNum).padStart(4, '0')}`;
    const { data: conflict } = await db
      .from('customers')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    if (!conflict) return code;
    nextNum++;
  }

  return `CUST${Date.now().toString(36).toUpperCase()}`;
}

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only super_admin can batch generate codes
    const { data: authUser } = await db
      .from('users')
      .select('role')
      .eq('id', authUserId)
      .single();

    if (!authUser || authUser.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Hanya Super Admin yang dapat generate kode PWA pelanggan' },
        { status: 403 }
      );
    }

    // Find all customers without a code
    const { data: customersWithoutCode, error: fetchError } = await db
      .from('customers')
      .select('id, name')
      .is('code', null)
      .neq('status', 'inactive');

    if (fetchError) {
      console.error('[Generate-Codes] Error fetching customers:', fetchError);
      return NextResponse.json(
        { error: 'Gagal mengambil data pelanggan' },
        { status: 500 }
      );
    }

    if (!customersWithoutCode || customersWithoutCode.length === 0) {
      return NextResponse.json({
        message: 'Semua pelanggan sudah memiliki kode PWA',
        generated: 0,
        customers: [],
      });
    }

    // Generate unique code for each customer
    const results: Array<{ id: string; name: string; code: string }> = [];
    let errorCount = 0;

    for (const customer of customersWithoutCode) {
      try {
        const code = await generateCustomerCode();
        const { error: updateError } = await db
          .from('customers')
          .update({ code })
          .eq('id', customer.id);

        if (updateError) {
          console.error(`[Generate-Codes] Error updating customer ${customer.id}:`, updateError);
          errorCount++;
        } else {
          results.push({
            id: customer.id,
            name: customer.name,
            code,
          });
        }
      } catch (err) {
        console.error(`[Generate-Codes] Error generating code for customer ${customer.id}:`, err);
        errorCount++;
      }
    }

    return NextResponse.json({
      message: `Berhasil generate ${results.length} kode PWA pelanggan${errorCount > 0 ? ` (${errorCount} gagal)` : ''}`,
      generated: results.length,
      failed: errorCount,
      customers: results,
    });
  } catch (error) {
    console.error('Generate customer codes error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
