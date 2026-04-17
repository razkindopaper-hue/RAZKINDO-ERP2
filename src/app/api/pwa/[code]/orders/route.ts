import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, createEvent, generateId, generateInvoiceNo } from '@/lib/supabase-helpers';
import { getWhatsAppConfig, sendMessage, disableWhatsAppOnInvalidToken } from '@/lib/whatsapp';
import { wsTransactionUpdate } from '@/lib/ws-dispatch';

// =====================================================================
// PWA Customer Orders
// GET /api/pwa/[code]/orders — Returns customer's transaction history
// POST /api/pwa/[code]/orders — Creates new order from customer PWA
// =====================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;

    if (!code || code.trim().length === 0) {
      return NextResponse.json({ error: 'Kode pelanggan diperlukan' }, { status: 400 });
    }

    // Look up customer (only active)
    const { data: customer } = await db
      .from('customers')
      .select('id, unit_id')
      .eq('code', code.trim().toUpperCase())
      .eq('status', 'active')
      .single();

    if (!customer) {
      return NextResponse.json({ error: 'Kode pelanggan tidak ditemukan' }, { status: 404 });
    }

    // Fetch transactions for this customer (sale type only, with items and payment proofs)
    const { data: transactions } = await db
      .from('transactions')
      .select(`
        *,
        unit:units(id, name),
        created_by:users!created_by_id(id, name),
        items:transaction_items(*, product:products(unit, subUnit))
      `)
      .eq('customer_id', customer.id)
      .eq('type', 'sale')
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(100);

    // Fetch payment proofs for these transactions
    const txIds = (transactions || []).map((t: any) => t.id);
    let proofs: any[] = [];
    if (txIds.length > 0) {
      const { data: proofData } = await db
        .from('payment_proofs')
        .select('id, transaction_id, invoice_no, file_url, file_name, uploaded_at')
        .in('transaction_id', txIds)
        .order('uploaded_at', { ascending: false });
      proofs = proofData || [];
    }

    // Fetch cashback logs for this customer (earned from orders)
    const { data: cashbackLogs } = await db
      .from('cashback_log')
      .select('id, transaction_id, type, amount, created_at')
      .eq('customer_id', customer.id)
      .eq('type', 'earned')
      .order('created_at', { ascending: false });

    // Group proofs by transaction_id
    const proofsByTx = new Map<string, any[]>();
    for (const p of proofs) {
      const txId = p.transaction_id;
      if (!proofsByTx.has(txId)) proofsByTx.set(txId, []);
      proofsByTx.get(txId)!.push(toCamelCase(p));
    }

    // Map cashback by transaction_id
    const cashbackByTx = new Map<string, number>();
    for (const cl of (cashbackLogs || [])) {
      if (cl.transaction_id) {
        cashbackByTx.set(cl.transaction_id, (cashbackByTx.get(cl.transaction_id) || 0) + cl.amount);
      }
    }

    const transactionsCamel = (transactions || []).map((t: any) => {
      const camel = toCamelCase(t);
      return {
        ...camel,
        createdBy: camel.createdBy || null,
        unit: camel.unit || null,
        items: (camel.items || []).map((i: any) => ({
          ...i,
          product: i.product || null,
        })),
        paymentProofs: proofsByTx.get(t.id) || [],
        cashbackEarned: cashbackByTx.get(t.id) || 0,
      };
    });

    return NextResponse.json({ orders: transactionsCamel });
  } catch (error) {
    console.error('PWA orders GET error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;

    if (!code || code.trim().length === 0) {
      return NextResponse.json({ error: 'Kode pelanggan diperlukan' }, { status: 400 });
    }

    const data = await request.json();

    // Look up customer (only active)
    const { data: customer } = await db
      .from('customers')
      .select('id, name, phone, unit_id, assigned_to_id, cashback_balance, cashback_type, cashback_value')
      .eq('code', code.trim().toUpperCase())
      .eq('status', 'active')
      .single();

    if (!customer) {
      return NextResponse.json({ error: 'Kode pelanggan tidak ditemukan' }, { status: 404 });
    }

    // Validate items — only need productId, productName, qty (NO price needed from customer)
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return NextResponse.json({ error: 'Item pesanan wajib diisi' }, { status: 400 });
    }

    for (const item of data.items) {
      if (!item.productId || !item.productName || !item.qty || item.qty <= 0) {
        return NextResponse.json({ error: 'Setiap item harus memiliki productId, productName, dan qty' }, { status: 400 });
      }
    }

    // Payment method: default 'tempo' — sales/admin will set the actual method when approving
    const paymentMethod = 'tempo';

    // Find the assigned sales user (or any sales in unit as fallback) BEFORE creating transaction
    let createdById = customer.assigned_to_id;
    if (!createdById) {
      const { data: salesUser } = await db
        .from('users')
        .select('id, name, phone')
        .eq('unit_id', customer.unit_id)
        .eq('role', 'sales')
        .eq('status', 'approved')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      createdById = salesUser?.id;
    }

    // Fallback to super_admin if no sales found
    if (!createdById) {
      const { data: anyAdmin } = await db
        .from('users')
        .select('id, name, phone')
        .eq('role', 'super_admin')
        .eq('status', 'approved')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      createdById = anyAdmin?.id;
    }

    if (!createdById) {
      return NextResponse.json({ error: 'Tidak ada user yang tersedia untuk menerima pesanan' }, { status: 400 });
    }

    // Generate invoice number with retry for race conditions
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let invoiceNo: string = '';
    let transactionId: string = '';
    let transaction: any = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const { count: txCount } = await db
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('type', 'sale')
        .gte('created_at', monthStart.toISOString());

      invoiceNo = generateInvoiceNo('sale', txCount || 0) + (attempt > 0 ? `-${attempt}` : '');
      transactionId = generateId();

      try {
        // Create transaction — STATUS: PENDING (needs approval from sales/admin)
        const result = await db
          .from('transactions')
          .insert({
            id: transactionId,
            type: 'sale',
            invoice_no: invoiceNo,
            unit_id: customer.unit_id,
            created_by_id: createdById,
            customer_id: customer.id,
            total: 0,
            paid_amount: 0,
            remaining_amount: 0,
            total_hpp: 0,
            total_profit: 0,
            hpp_paid: 0,
            profit_paid: 0,
            hpp_unpaid: 0,
            profit_unpaid: 0,
            payment_method: paymentMethod,
            status: 'pending',
            payment_status: 'unpaid',
            notes: data.notes || `Order dari PWA (${customer.name})`,
            transaction_date: now.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select(`
            *,
            unit:units(*),
            created_by:users!created_by_id(id, name, phone),
            customer:customers(*)
          `)
          .single();

        if (result.error) throw result.error;
        transaction = result.data;
        break;
      } catch (error: any) {
        // Retry on unique constraint violation (duplicate invoice number)
        const isDuplicateKey = error.code === '23505' ||
          error.message?.includes('duplicate key') ||
          error.message?.includes('23505') ||
          error.message?.includes('unique constraint');
        if (isDuplicateKey && attempt < 2) continue;
        console.error('PWA order create error:', error);
        return NextResponse.json({ error: 'Gagal membuat pesanan' }, { status: 500 });
      }
    }

    if (!transaction) {
      return NextResponse.json({ error: 'Gagal membuat pesanan setelah 3 percobaan' }, { status: 500 });
    }

    // Build items list — explicitly extract only needed fields (no spreading)
    const items = data.items.map((item: any) => ({
      productId: item.productId,
      productName: item.productName,
      qty: item.qty,
      price: 0,
      hpp: 0,
      subtotal: 0,
      qtyInSubUnit: item.qty,
      qtyUnitType: 'main',
      profit: 0,
    }));

    // Insert transaction items with price=0 (sales will update later)
    const txItems = items.map(item => ({
      id: generateId(),
      transaction_id: transactionId,
      product_id: item.productId,
      product_name: item.productName,
      qty: item.qty,
      qty_in_sub_unit: item.qty,
      qty_unit_type: item.qtyUnitType || 'main',
      price: 0,
      hpp: 0,
      subtotal: 0,
      profit: 0,
    }));

    await db.from('transaction_items').insert(txItems);

    // Create event for notification
    createEvent(db, 'pwa_order_pending', {
      transactionId,
      invoiceNo,
      type: 'sale',
      unitId: customer.unit_id,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      salesId: createdById,
      source: 'pwa',
    }).catch(() => {});

    // Dispatch WebSocket update for real-time notification
    wsTransactionUpdate({ invoiceNo, type: 'sale', status: 'pending', unitId: customer.unit_id });

    // Send WhatsApp notification to sales
    try {
      const config = await getWhatsAppConfig();
      if (config.enabled && config.token && config.target_id) {
        const sales = (transaction as any).created_by;
        const itemsList = data.items.map((i: any) => `• ${i.productName} x${i.qty}`).join('\n');
        const payMethod = 'Tempo (ditentukan Sales/Admin)';
        const dateStr = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        const message = `🛒 *ORDER BARU DARI PWA*\n\n` +
          `📄 Invoice: ${invoiceNo}\n` +
          `👤 Pelanggan: ${customer.name}\n` +
          `📱 Telp: ${customer.phone || '-'}\n` +
          `📅 Tanggal: ${dateStr}\n` +
          `💰 Bayar: ${payMethod}\n\n` +
          `📦 *Daftar Item:*\n${itemsList}\n\n` +
          `⚠️ *Menunggu Persetujuan*\n` +
          `Order ini perlu di-set harga & metode bayar (Cash/Transfer/Tempo) dan di-approve oleh Sales/Admin.\n` +
          `Login ke ERP untuk memproses.`;

        const result = await sendMessage(config.token, config.target_id, message);
        if (!result.success && result.tokenInvalid) {
          await disableWhatsAppOnInvalidToken();
        }
      }
    } catch (waErr) {
      console.error('PWA WhatsApp notification error (non-blocking):', waErr);
    }

    const txCamel = toCamelCase(transaction);
    return NextResponse.json({
      order: {
        ...txCamel,
        createdBy: toCamelCase(txCamel.createdBy || null),
        customer: toCamelCase(txCamel.customer || null),
        unit: toCamelCase(txCamel.unit || null),
        items: items.map(i => ({
          id: i.productId,
          productName: i.productName,
          qty: i.qty,
        })),
        cashbackEarned: 0,
        status: 'pending',
      },
    });
  } catch (error) {
    console.error('PWA orders POST error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
