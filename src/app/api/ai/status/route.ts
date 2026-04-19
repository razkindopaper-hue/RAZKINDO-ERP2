// =====================================================================
// GET /api/ai/status - Check AI configuration & list available models
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { isAvailable, listModels } from '@/lib/ai';

export async function GET(request: NextRequest) {
  try {
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const configured = isAvailable();

    if (!configured) {
      return NextResponse.json({
        configured: false,
        connected: false,
        models: [],
        defaultModel: null,
        message: 'AI belum dikonfigurasi. Tambahkan GROQ_API_KEY di .env. Dapatkan gratis di https://console.groq.com/keys',
      });
    }

    // Groq is a cloud API — no connection check needed
    // Just return the available models
    const models = await listModels();
    const defaultModel = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

    return NextResponse.json({
      configured: true,
      connected: true, // Cloud API — always connected if key is valid
      models,
      defaultModel,
      hasDefaultModel: models.length > 0,
      provider: 'Groq (Free)',
    });
  } catch (err: any) {
    console.error('[AI/Status] Error:', err);
    return NextResponse.json({ error: err.message || 'Gagal cek status AI' }, { status: 500 });
  }
}
