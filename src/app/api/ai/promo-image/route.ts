// =====================================================================
// AI PROMO IMAGE GENERATION API
// Endpoint: POST /api/ai/promo-image
//
// Generates promotional images for products using AI.
// Uses product data to create compelling promo content.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAndGetAuthUser } from '@/lib/token';

export async function POST(request: NextRequest) {
  try {
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
    const { productId, productName, category, sellingPrice, customPrompt } = body;

    // Build the promo image prompt
    let prompt = '';

    if (customPrompt && customPrompt.trim().length > 10) {
      prompt = customPrompt.trim();
    } else if (productId) {
      const { data: product } = await db
        .from('products')
        .select('name, category, unit, selling_price, subUnit')
        .eq('id', productId)
        .maybeSingle();

      if (product) {
        const cat = product.category || category || 'product';
        prompt = buildPromoPrompt(product.name, cat, product.selling_price || sellingPrice);
      }
    } else if (productName) {
      prompt = buildPromoPrompt(productName, category || 'product', sellingPrice);
    } else {
      return NextResponse.json({ error: 'productId, productName, atau customPrompt wajib diisi' }, { status: 400 });
    }

    // Generate image via z-ai-web-dev-sdk
    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    const zai = await ZAI.create();

    const response = await zai.images.generations.create({
      prompt,
      size: '1024x1024',
    });

    const imageBase64 = response.data[0]?.base64;
    if (!imageBase64) {
      return NextResponse.json({ error: 'Gagal generate gambar promo' }, { status: 500 });
    }

    const imageUrl = `data:image/png;base64,${imageBase64}`;

    return NextResponse.json({
      success: true,
      imageUrl,
      prompt,
    });
  } catch (error: any) {
    console.error('[AI Promo Image] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Gagal generate gambar promo' },
      { status: 500 }
    );
  }
}

function buildPromoPrompt(productName: string, category: string, price?: number): string {
  const priceText = price ? ` with price tag Rp ${price.toLocaleString('id-ID')}` : '';

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
  };

  const categoryDetail = categoryPrompts[category] || 'high quality commercial product';

  return `Professional promotional poster for "${productName}", ${categoryDetail}, vibrant promotional banner style, modern marketing design, bold typography, discount sale tag${priceText}, attractive commercial advertising, clean layout, studio lighting, e-commerce style, Indonesian market, 4K quality`;
}
