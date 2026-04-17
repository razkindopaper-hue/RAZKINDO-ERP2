import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase } from '@/lib/supabase-helpers';

/**
 * GET /api/payment/[invoiceNo]
 * PUBLIC — No authentication required
 * Returns transaction details for the customer-facing payment page.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceNo: string }> }
) {
  try {
    const { invoiceNo } = await params;

    // Look up transaction by invoice_no with related data
    const result = await db
      .from('transactions')
      .select(`
        id, type, invoice_no, total, paid_amount, remaining_amount,
        payment_method, status, payment_status, due_date,
        transaction_date, deliveryAddress, notes,
        courier_commission, delivery_distance,
        customer:customers(id, name, phone, address),
        created_by:users!created_by_id(name),
        unit:units(name),
        items:transaction_items(id, product_id, product_name, qty, price, subtotal, qty_in_sub_unit, qty_unit_type, product:products(name))
      `)
      .eq('invoice_no', invoiceNo)
      .single();

    console.log('[PAYMENT-DEBUG] invoiceNo:', invoiceNo, 'error:', JSON.stringify(result.error), 'data:', !!result.data, 'status:', result.status);

    const { data: transaction, error } = result;

    if (error || !transaction) {
      // Prisma fallback for resilience
      console.log('[PAYMENT-DEBUG] Supabase failed, trying Prisma fallback...');
      try {
        const { prisma } = await import('@/lib/supabase');
        const prismaTx = await prisma.transaction.findUnique({
          where: { invoiceNo },
          include: {
            customer: { select: { id: true, name: true, phone: true, address: true } },
            createdBy: { select: { name: true } },
            unit: { select: { name: true } },
            items: {
              include: { product: { select: { name: true } } }
            },
          },
        });
        if (prismaTx) {
          console.log('[PAYMENT-DEBUG] Prisma fallback found transaction:', prismaTx.id);
          // Continue with Prisma data - convert to expected format
          const proofsResult = await prisma.paymentProof.findMany({
            where: { transactionId: prismaTx.id },
            orderBy: { uploadedAt: 'desc' },
          });
          const proofs = proofsResult.map((p: any) => ({
            id: p.id,
            transaction_id: p.transactionId,
            invoice_no: p.invoiceNo,
            file_url: p.fileUrl,
            file_name: p.fileName,
            uploaded_at: p.uploadedAt.toISOString(),
            viewed: p.viewed,
            created_at: p.createdAt.toISOString(),
          }));
          const transactionCamel = {
            id: prismaTx.id,
            type: prismaTx.type,
            invoiceNo: prismaTx.invoiceNo,
            total: Number(prismaTx.total),
            paidAmount: Number(prismaTx.paidAmount),
            remainingAmount: Number(prismaTx.remainingAmount),
            paymentMethod: prismaTx.paymentMethod,
            status: prismaTx.status,
            paymentStatus: prismaTx.paymentStatus,
            dueDate: prismaTx.dueDate?.toISOString() || null,
            transactionDate: prismaTx.transactionDate?.toISOString() || null,
            deliveryAddress: prismaTx.deliveryAddress,
            notes: prismaTx.notes,
            courierCommission: Number(prismaTx.courierCommission || 0),
            deliveryDistance: prismaTx.deliveryDistance,
            createdBy: prismaTx.createdBy ? { name: prismaTx.createdBy.name } : null,
            customer: prismaTx.customer ? { id: prismaTx.customer.id, name: prismaTx.customer.name, phone: prismaTx.customer.phone, address: prismaTx.customer.address } : null,
            unit: prismaTx.unit ? { name: prismaTx.unit.name } : null,
            items: (prismaTx.items || []).map((i: any) => ({
              id: i.id,
              productId: i.productId,
              productName: i.productName,
              qty: Number(i.qty),
              price: Number(i.price),
              subtotal: Number(i.subtotal),
              qtyInSubUnit: Number(i.qtyInSubUnit || 0),
              qtyUnitType: i.qtyUnitType || 'sub',
              product: i.product ? { name: i.product.name } : null,
            })),
          };
          const alreadyPaid = prismaTx.paymentStatus === 'paid';
          return NextResponse.json({
            transaction: transactionCamel,
            proofs: proofs,
            ...(alreadyPaid ? { alreadyPaid: true } : {}),
          });
        }
      } catch (prismaErr) {
        console.error('[PAYMENT-DEBUG] Prisma fallback also failed:', prismaErr);
      }
      return NextResponse.json(
        { error: 'Transaksi tidak ditemukan', debug: error?.message || 'no error object' },
        { status: 404 }
      );
    }

    // Check if transaction is cancelled
    if (transaction.status === 'cancelled') {
      return NextResponse.json(
        { error: 'Transaksi sudah dibatalkan' },
        { status: 400 }
      );
    }

    // Fetch existing payment proofs for this transaction
    const { data: proofs } = await db
      .from('payment_proofs')
      .select('*')
      .eq('transaction_id', transaction.id)
      .order('uploaded_at', { ascending: false });

    // Mark all proofs as viewed (fire-and-forget)
    (async () => {
      try {
        await db.from('payment_proofs')
          .update({ viewed: true })
          .eq('transaction_id', transaction.id);
      } catch (err: any) {
        console.error('[Payment] Failed to mark proofs as viewed:', err);
      }
    })();

    const transactionCamel = toCamelCase(transaction);
    const proofsCamel = proofs ? proofs.map((p) => toCamelCase(p)) : [];

    // Check if already paid
    const alreadyPaid = transaction.payment_status === 'paid';

    return NextResponse.json({
      transaction: {
        ...transactionCamel,
        createdBy: transactionCamel.createdBy || null,
        customer: transactionCamel.customer || null,
        unit: transactionCamel.unit || null,
        items: (transactionCamel.items || []).map((i: any) => ({
          ...i,
          product: i.product || null,
        })),
      },
      proofs: proofsCamel,
      ...(alreadyPaid ? { alreadyPaid: true } : {}),
    });
  } catch (error) {
    console.error('Get payment transaction error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
