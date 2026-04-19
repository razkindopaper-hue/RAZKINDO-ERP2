import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase } from '@/lib/supabase-helpers';
import { verifyAndGetAuthUser } from '@/lib/token';

// =====================================================================
// GET /api/customers/[id]/referrals
// Get referral stats and list for a specific customer
// =====================================================================
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const result = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!result) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Fetch the customer
    const { data: customer } = await db
      .from('customers')
      .select('id, name, code, cashback_balance')
      .eq('id', id)
      .maybeSingle();

    if (!customer) {
      return NextResponse.json({ error: 'Pelanggan tidak ditemukan' }, { status: 404 });
    }

    // Fetch referrals made BY this customer (as referrer)
    const { data: referralsMade } = await db
      .from('customer_referral')
      .select(`
        *,
        referral_customer:customers!referral_customer_id(id, name, phone, code, status)
      `)
      .eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    // Fetch referrals where this customer IS the referred customer
    const { data: referralReceived } = await db
      .from('customer_referral')
      .select(`
        *,
        customer:customers!customer_id(id, name, phone, code, status)
      `)
      .eq('referral_customer_id', id)
      .maybeSingle();

    // Count stats
    const allReferrals = referralsMade || [];
    const stats = {
      totalReferralsMade: allReferrals.length,
      new: allReferrals.filter((r: any) => r.status === 'new').length,
      contacted: allReferrals.filter((r: any) => r.status === 'contacted').length,
      converted: allReferrals.filter((r: any) => r.status === 'converted').length,
      lost: allReferrals.filter((r: any) => r.status === 'lost').length,
      bonusEarned: 0,
    };

    // Calculate bonus earned from converted referrals via cashback_log
    const { data: cashbackLogs } = await db
      .from('cashback_log')
      .select('amount')
      .eq('customer_id', id)
      .eq('type', 'referral_bonus');

    stats.bonusEarned = (cashbackLogs || []).reduce((sum: number, log: any) => sum + (log.amount || 0), 0);

    // Fetch referral bonus config
    const { data: refConfig } = await db
      .from('cashback_config')
      .select('referral_bonus_type, referral_bonus_value')
      .eq('is_active', true)
      .maybeSingle();

    return NextResponse.json({
      customer: toCamelCase(customer),
      referralsMade: allReferrals.map((r: any) => ({
        ...toCamelCase(r),
        referralCustomer: toCamelCase(r.referral_customer || null),
      })),
      referralReceived: referralReceived ? {
        ...toCamelCase(referralReceived),
        customer: toCamelCase(referralReceived.customer || null),
      } : null,
      stats,
      referralConfig: refConfig ? toCamelCase(refConfig) : null,
    });
  } catch (error) {
    console.error('[CUSTOMER_REFERRALS] Error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
