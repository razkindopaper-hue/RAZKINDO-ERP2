// =====================================================================
// AI Utility — Free AI using Groq API (free tier: fast LLM)
// =====================================================================
// Replaces Ollama with Groq API — no local server needed.
// Free tier: 30 requests/min, unlimited requests.
// Sign up: https://console.groq.com/keys
//
// Environment variables:
//   GROQ_API_KEY  — Required. Get free key at https://console.groq.com/keys
//   AI_MODEL      — Optional. Default: llama-3.3-70b-versatile
//
// Fallback models (tried in order):
//   1. llama-3.3-70b-versatile  (default, best quality)
//   2. llama-3.1-8b-instant     (fast, low latency)
//   3. gemma2-9b-it             (Google model)
//   4. mixtral-8x7b-32768       (Mixtral MoE)
// =====================================================================

const GROQ_API_BASE = 'https://api.groq.com/openai/v1/chat/completions';

// Models to try in order (best quality first)
const MODEL_FALLBACKS = [
  process.env.AI_MODEL || 'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'mixtral-8x7b-32768',
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(err: any): boolean {
  const msg = err?.message || '';
  const status = err?.status || err?.statusCode || 0;
  return (
    status === 429 ||
    status === 503 ||
    status === 502 ||
    msg.includes('429') ||
    msg.includes('Too Many Requests') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('fetch failed') ||
    msg.includes('rate limit')
  );
}

/**
 * Call Groq API with retry logic
 */
async function callGroq(options: {
  messages: { role: string; content: string }[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY belum dikonfigurasi. Tambahkan GROQ_API_KEY di file .env. Dapatkan gratis di https://console.groq.com/keys');
  }

  const modelsToTry = options.model
    ? [options.model]
    : MODEL_FALLBACKS;

  let lastError: any;

  for (const model of modelsToTry) {
    const maxRetries = options.maxRetries ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(GROQ_API_BASE, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: options.messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 4096,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const err: any = new Error(`Groq API ${response.status}: ${errorBody.substring(0, 200)}`);
          err.status = response.status;
          throw err;
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content || '';

        if (!content) {
          throw new Error('Groq API mengembalikan respons kosong');
        }

        console.log(`[AI] Used model: ${model}`);
        return content;
      } catch (err: any) {
        lastError = err;
        const status = err?.status || 0;

        // Don't retry auth errors or bad requests
        if (status === 401 || status === 400 || status === 404) {
          console.warn(`[AI] Model ${model} fatal error (${status}), skipping`);
          break; // Try next model
        }

        // Retry on transient errors
        if (isRetryableError(err) && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.warn(`[AI] ${model} error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
          await sleep(delay);
          continue;
        }

        console.warn(`[AI] Model ${model} failed: ${err.message?.substring(0, 100)}`);
        break; // Try next model
      }
    }
  }

  // All models failed
  const errMsg = lastError?.message || 'Unknown error';
  if (lastError?.status === 401) {
    throw new Error(`GROQ_API_KEY tidak valid. Cek kembali key di .env. Error: ${errMsg.substring(0, 200)}`);
  }
  throw lastError || new Error('Semua model AI gagal');
}

/**
 * Chat completion — drop-in replacement for Ollama chatCompletion()
 *
 * @param options.messages - Array of { role: 'system'|'user'|'assistant', content: string }
 * @param options.model - Groq model name (auto-fallback if not specified)
 * @returns { content: string }
 */
export async function chatCompletion(options: {
  messages: { role: string; content: string }[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<{ content: string }> {
  const content = await callGroq({
    messages: options.messages,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxOutputTokens,
  });
  return { content };
}

/**
 * Simple text generation (no conversation history)
 */
export async function generateText(options: {
  prompt: string;
  systemInstruction?: string;
  model?: string;
  temperature?: number;
}): Promise<string> {
  const messages: { role: string; content: string }[] = [];

  if (options.systemInstruction) {
    messages.push({ role: 'system', content: options.systemInstruction });
  }
  messages.push({ role: 'user', content: options.prompt });

  return callGroq({
    messages,
    model: options.model,
    temperature: options.temperature,
  });
}

/**
 * Check if AI is available (has API key configured)
 */
export function isAvailable(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/**
 * Return status info about the AI configuration
 * No server connection needed — Groq is a cloud API
 */
export async function listModels(): Promise<string[]> {
  if (!process.env.GROQ_API_KEY) return [];
  // Return available models (static list — Groq free tier supports these)
  return MODEL_FALLBACKS.filter(m => !m.includes('process.env'));
}
