import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase } from '@/lib/supabase-helpers';

// =====================================================================
// PWA Products - Public (no auth required)
// GET /api/pwa/[code]/products — Returns active products for the customer
// Products the customer frequently purchases are shown first with badges
// =====================================================================

interface ProductInfo {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  subUnit: string | null;
  conversionRate: number | null;
  price: number;
  stock: number;
  imageUrl: string | null;
  purchaseCount: number;
  lastPurchased: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;

    if (!code || code.trim().length === 0) {
      return NextResponse.json(
        { error: 'Kode pelanggan diperlukan' },
        { status: 400 }
      );
    }

    // Look up customer to get unit_id
    const { data: customer, error: customerError } = await db
      .from('customers')
      .select('id, unit_id')
      .eq('code', code.trim().toUpperCase())
      .eq('status', 'active')
      .single();

    if (customerError || !customer) {
      return NextResponse.json(
        { error: 'Kode pelanggan tidak ditemukan' },
        { status: 404 }
      );
    }

    // ── Run purchase history + unit products in parallel, then fetch products (paginated) ──
    const [purchaseHistoryResult, unitProductsResult] = await Promise.all([
      // Purchase history: single nested query (no batching needed)
      db
        .from('transactions')
        .select('transaction_items(product_id, qty, created_at)')
        .eq('customer_id', customer.id)
        .eq('type', 'sale')
        .neq('status', 'cancelled'),

      // Per-unit stock mapping
      db
        .from('unit_products')
        .select('product_id, stock')
        .eq('unit_id', customer.unit_id),
    ]);

    // All active products (paginated to avoid silent truncation)
    const PWA_BATCH = 1000;
    let allPwaProducts: any[] = [];
    let pwaProductsError: any = null;
    let pwaPage = 0;
    while (true) {
      const result = await db
        .from('products')
        .select('id, name, sku, unit, subUnit, conversionRate, selling_price, global_stock, min_stock, is_active, stock_type, image_url')
        .eq('is_active', true)
        .order('name', { ascending: true })
        .range(pwaPage * PWA_BATCH, (pwaPage + 1) * PWA_BATCH - 1);
      if (result.error) { pwaProductsError = result.error; break; }
      if (!result.data || result.data.length === 0) break;
      allPwaProducts.push(...result.data);
      if (result.data.length < PWA_BATCH) break;
      pwaPage++;
      if (pwaPage >= 10) break;
    }

    // ── Build purchase frequency map from nested results ──
    const purchaseMap = new Map<string, { count: number; totalQty: number; lastDate: string }>();
    const transactions = purchaseHistoryResult.data;
    if (Array.isArray(transactions)) {
      for (const tx of transactions) {
        const items = (tx as any).transaction_items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const pid = item.product_id;
          if (!pid) continue;
          const existing = purchaseMap.get(pid);
          const itemDate = item.created_at || '';
          if (existing) {
            existing.count += 1;
            existing.totalQty += item.qty || 0;
            if (itemDate > existing.lastDate) existing.lastDate = itemDate;
          } else {
            purchaseMap.set(pid, { count: 1, totalQty: item.qty || 0, lastDate: itemDate });
          }
        }
      }
    }

    // ── Build unit product stock map ──
    const unitProductMap = new Map<string, { stock: number }>();
    const unitProducts = unitProductsResult.data;
    if (Array.isArray(unitProducts)) {
      for (const up of unitProducts) {
        unitProductMap.set(up.product_id, { stock: up.stock });
      }
    }

    // ── Build product list with purchase info ──
    const products = allPwaProducts;
    if (pwaProductsError) {
      console.error('PWA products fetch error:', pwaProductsError);
      return NextResponse.json(
        { error: 'Gagal memuat produk' },
        { status: 500 }
      );
    }

    const productList: ProductInfo[] = [];

    for (const p of (products || [])) {
      const camel = toCamelCase(p);
      const productId = camel.id;

      // Determine effective stock based on stock_type
      let effectiveStock: number;
      if (camel.stockType === 'per_unit') {
        const up = unitProductMap.get(productId);
        if (!up) {
          // Product is per_unit but not assigned to this unit — show with stock=0 instead of silently skipping
          effectiveStock = 0;
        } else {
          effectiveStock = up.stock;
        }
      } else {
        // centralized or other
        effectiveStock = camel.globalStock || 0;
      }

      // Purchase history for this product
      const purchaseInfo = purchaseMap.get(productId);

      productList.push({
        id: productId,
        name: camel.name,
        sku: camel.sku,
        unit: camel.unit,
        subUnit: camel.subUnit,
        conversionRate: camel.conversionRate,
        price: 0, // Price hidden from customers — this is a pengajuan (price request)
        stock: effectiveStock,
        imageUrl: camel.imageUrl,
        purchaseCount: purchaseInfo?.count || 0,
        lastPurchased: purchaseInfo?.lastDate || null,
      });
    }

    // ── Sort: frequently purchased first, then by name ──
    productList.sort((a, b) => {
      // Products with purchase history come first
      if (a.purchaseCount > 0 && b.purchaseCount === 0) return -1;
      if (a.purchaseCount === 0 && b.purchaseCount > 0) return 1;
      // Among purchased products, sort by frequency (desc) then last purchased (desc)
      if (a.purchaseCount > 0 && b.purchaseCount > 0) {
        if (a.purchaseCount !== b.purchaseCount) return b.purchaseCount - a.purchaseCount;
        const aLast = a.lastPurchased || '';
        const bLast = b.lastPurchased || '';
        if (aLast > bLast) return -1;
        if (aLast < bLast) return 1;
      }
      // No purchase history: sort alphabetically
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({
      products: productList,
    });
  } catch (error) {
    console.error('PWA products error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
