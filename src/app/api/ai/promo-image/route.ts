// =====================================================================
// AI PROMO IMAGE GENERATION API
// Endpoint: POST /api/ai/promo-image
//
// Generates promotional images for products using AI.
// Supports:
// - Single product by productId, productName, or customPrompt
// - Batch by productIds array with promoType
// - Promo types: discount, bundle, new, flash_sale
//
// Uses z-ai-web-dev-sdk for image generation.
// Super Admin only.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAndGetAuthUser } from '@/lib/token';
import { createLog } from '@/lib/supabase-helpers';

type PromoType = 'discount' | 'bundle' | 'new' | 'flash_sale';

// =====================================================================
// PROMPT BUILDER
// =====================================================================

function buildPromoPrompt(
  productName: string,
  category: string,
  price?: number,
  promoType?: PromoType,
  customPrompt?: string,
): string {
  // If custom prompt is provided and substantial, use it
  if (customPrompt && customPrompt.trim().length > 10) {
    return customPrompt.trim();
  }

  const priceText = price ? `Rp ${price.toLocaleString('id-ID')}` : '';
  const categoryDetail = getCategoryVisual(category);

  const promoTypeDetails: Record<PromoType, string> = {
    discount: `bold "DISKON" stamp overlay, percentage off badge, sale tag, crossed-out original price next to ${priceText}`,
    bundle: `bundle deal visual, "PAKET HEMAT" badge, multiple products grouped together, value combo presentation`,
    new: `"BARU" badge overlay, "NEW ARRIVAL" tag, fresh product spotlight, launch celebration design`,
    flash_sale: `"FLASH SALE" urgent banner, countdown timer visual, lightning bolt icon, limited time offer urgency, bold red and yellow accents`,
  };

  const promoDetail = promoType ? promoTypeDetails[promoType] : '';

  return `Professional Indonesian e-commerce promotional poster for "${productName}"${promoType ? ` (${promoType.toUpperCase()})` : ''}, ${categoryDetail}, ${promoDetail || 'vibrant promotional banner style'}, modern marketing design, bold typography${priceText ? `, price tag "${priceText}"` : ''}, attractive commercial advertising, clean layout, studio lighting, Indonesian market style, high quality product photography, 4K quality, professional graphic design`;
}

function getCategoryVisual(category: string): string {
  const categoryPrompts: Record<string, string> = {
    'Semen': 'stacks of cement bags in a warehouse, construction material, professional product photo',
    'Bata': 'neatly arranged bricks, construction material, professional product photo',
    'Pasir': 'pile of clean sand, construction material, professional product photo',
    'Besi': 'steel bars and metal construction materials, professional product photo',
    'Cat': 'colorful paint cans arranged artistically, home improvement, professional product photo',
    'Keramik': 'beautiful ceramic tiles display, home improvement, professional product photo',
    'Kayu': 'wooden planks and timber, construction material, professional product photo',
    'Atap': 'roofing materials display, construction, professional product photo',
    'Pipa': 'PVC pipes and plumbing materials, professional product photo',
    'Listrik': 'electrical supplies and wiring, professional product photo',
    'Bahan Bangunan': 'building materials display, construction supplies, professional product photo',
    'Makanan': 'delicious food photography, appetizing presentation, food marketing',
    'Minuman': 'refreshing beverage photography, drink marketing, commercial product shot',
    'Elektronik': 'modern electronics product display, tech marketing, professional product shot',
  };

  return categoryPrompts[category] || 'high quality commercial product';
}

// =====================================================================
// IMAGE GENERATOR
// =====================================================================

async function generateImage(prompt: string): Promise<{ base64: string; imageUrl: string } | null> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default;
  const zai = await ZAI.create();

  const response = await zai.images.generations.create({
    prompt,
    size: '1344x768',
  });

  const imageBase64 = response.data[0]?.base64;
  if (!imageBase64) return null;

  return {
    base64: imageBase64,
    imageUrl: `data:image/png;base64,${imageBase64}`,
  };
}

// =====================================================================
// MAIN HANDLER
// =====================================================================

export async function POST(request: NextRequest) {
  try {
    // ── AUTH ──
    const authResult = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (authResult.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden — hanya Super Admin' }, { status: 403 });
    }

    const body = await request.json();
    const { productIds, productId, productName, category, sellingPrice, promoType, customPrompt } = body;

    // ── CASE 1: Batch generation by productIds ──
    if (productIds && Array.isArray(productIds) && productIds.length > 0) {
      const results: Array<{
        productId: string;
        productName: string;
        success: boolean;
        imageUrl?: string;
        prompt?: string;
        error?: string;
      }> = [];

      // Fetch product data
      const { data: products } = await db
        .from('products')
        .select('id, name, category, unit, selling_price, sub_unit, image_url')
        .in('id', productIds)
        .eq('is_active', true);

      if (!products || products.length === 0) {
        return NextResponse.json({ error: 'Produk tidak ditemukan atau tidak aktif' }, { status: 404 });
      }

      // Generate promo images (max 4 at a time to avoid timeout)
      const toGenerate = products.slice(0, 4);

      for (const product of toGenerate) {
        const camel = toCamelCase(product) as any;
        try {
          const prompt = buildPromoPrompt(
            camel.name,
            camel.category || category || 'product',
            camel.sellingPrice || sellingPrice,
            promoType as PromoType,
            customPrompt,
          );

          const imageResult = await generateImage(prompt);
          if (imageResult) {
            results.push({
              productId: camel.id,
              productName: camel.name,
              success: true,
              imageUrl: imageResult.imageUrl,
              prompt,
            });
          } else {
            results.push({
              productId: camel.id,
              productName: camel.name,
              success: false,
              error: 'Gagal generate gambar',
            });
          }
        } catch (err: any) {
          results.push({
            productId: camel.id,
            productName: camel.name,
            success: false,
            error: err.message || 'Gagal generate gambar',
          });
        }
      }

      // Log batch generation
      await createLog(db, {
        type: 'ai_action',
        userId: authResult.userId,
        action: 'promo_image_batch',
        entity: 'products',
        payload: JSON.stringify({
          productIds: toGenerate.map((p: any) => p.id),
          promoType,
          successCount: results.filter(r => r.success).length,
          failCount: results.filter(r => !r.success).length,
        }),
        message: `Batch promo image: ${results.filter(r => r.success).length}/${results.length} berhasil`,
      });

      return NextResponse.json({
        success: true,
        results,
        promoType: promoType || 'general',
        totalRequested: toGenerate.length,
        totalGenerated: results.length,
      });
    }

    // ── CASE 2: Single product generation ──
    // Build the promo image prompt
    let prompt = '';

    if (productId) {
      const { data: product } = await db
        .from('products')
        .select('name, category, unit, selling_price, sub_unit, image_url')
        .eq('id', productId)
        .maybeSingle();

      if (product) {
        const cat = product.category || category || 'product';
        prompt = buildPromoPrompt(product.name, cat, product.selling_price || sellingPrice, promoType as PromoType, customPrompt);
      } else {
        return NextResponse.json({ error: 'Produk tidak ditemukan' }, { status: 404 });
      }
    } else if (productName) {
      prompt = buildPromoPrompt(productName, category || 'product', sellingPrice, promoType as PromoType, customPrompt);
    } else {
      return NextResponse.json({ error: 'productId, productName, productIds, atau customPrompt wajib diisi' }, { status: 400 });
    }

    // Generate image
    const imageResult = await generateImage(prompt);
    if (!imageResult) {
      return NextResponse.json({ error: 'Gagal generate gambar promo' }, { status: 500 });
    }

    // Log generation
    await createLog(db, {
      type: 'ai_action',
      userId: authResult.userId,
      action: 'promo_image_single',
      entity: 'products',
      entityId: productId || null,
      payload: JSON.stringify({ productName, productId, promoType, prompt }),
      message: `Promo image generated: ${productName || productId}`,
    });

    return NextResponse.json({
      success: true,
      imageUrl: imageResult.imageUrl,
      prompt,
      promoType: promoType || 'general',
    });
  } catch (error: any) {
    console.error('[AI Promo Image] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Gagal generate gambar promo' },
      { status: 500 }
    );
  }
}

function toCamelCase<T = Record<string, any>>(row: Record<string, any> | null): T {
  if (!row) return null as unknown as T;
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = value;
  }
  return result as T;
}
