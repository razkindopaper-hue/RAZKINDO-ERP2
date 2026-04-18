// =====================================================================
// Ollama AI Utility — Wrapper for Ollama LLM API
// =====================================================================
// Replaces Google Gemini with Ollama for local/cloud LLM inference.
//
// Features:
// - Compatible with Ollama API (local or cloud)
// - Auto-retry on transient errors with exponential backoff
// - Fallback to alternative models if primary is unavailable
// - Graceful error handling
// =====================================================================

import { Ollama } from 'ollama';

let _ollama: Ollama | null = null;

// Models to try in order (best quality first)
// Default model from env, with fallback chain
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3:8b';
const MODEL_FALLBACKS = [
  DEFAULT_MODEL,
  'llama3:8b',
  'llama3:latest',
  'mistral:latest',
  'qwen2.5:7b',
  'gemma2:9b',
];

function getOllama(): Ollama {
  if (_ollama) return _ollama;

  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const apiKey = process.env.OLLAMA_API_KEY;

  _ollama = new Ollama({
    host,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });

  return _ollama;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(err: any): boolean {
  const msg = err?.message || '';
  return (
    msg.includes('429') ||
    msg.includes('Too Many Requests') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('503') ||
    msg.includes('connection refused') ||
    msg.includes('fetch failed')
  );
}

function isModelNotFoundError(err: any): boolean {
  const msg = err?.message || '';
  return msg.includes('404') || msg.includes('not found') || msg.includes('model') && msg.includes('not');
}

/**
 * Try a single model with retries
 */
async function tryWithRetries<T>(
  modelName: string,
  fn: () => Promise<T>,
  maxRetries: number = 2,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (isModelNotFoundError(err)) {
        throw err; // Don't retry model-not-found
      }
      if (isRetryableError(err) && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`[Ollama] ${modelName} error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Chat completion — drop-in replacement for Gemini chatCompletion()
 *
 * @param options.messages - Array of { role: 'system'|'user'|'assistant', content: string }
 * @param options.model - Ollama model name (auto-fallback if not specified)
 * @returns { content: string }
 */
export async function chatCompletion(options: {
  messages: { role: string; content: string }[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<{ content: string }> {
  const modelsToTry = options.model
    ? [options.model]
    : MODEL_FALLBACKS;

  let lastError: any;

  for (const modelName of modelsToTry) {
    try {
      const result = await tryWithRetries(modelName, async () => {
        const response = await getOllama().chat({
          model: modelName,
          messages: options.messages.map(m => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: m.content,
          })),
          options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.maxOutputTokens ?? 4096,
          },
        });
        return response.message?.content || '';
      });

      console.log(`[Ollama] Used model: ${modelName}`);
      return { content: result };
    } catch (err: any) {
      lastError = err;
      console.warn(`[Ollama] Model ${modelName} failed: ${err.message?.substring(0, 100)}`);
      // Continue to next model
    }
  }

  // All models failed
  const errMsg = lastError?.message || 'Unknown error';
  if (errMsg.includes('ECONNREFUSED') || errMsg.includes('connection refused')) {
    throw new Error(`Ollama server tidak bisa dijangkau. Pastikan Ollama berjalan di ${process.env.OLLAMA_HOST || 'http://localhost:11434'}. Original: ${errMsg.substring(0, 200)}`);
  }
  throw lastError || new Error('Semua model Ollama gagal');
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
  const modelsToTry = options.model
    ? [options.model]
    : MODEL_FALLBACKS;

  let lastError: any;

  for (const modelName of modelsToTry) {
    try {
      const result = await tryWithRetries(modelName, async () => {
        const response = await getOllama().generate({
          model: modelName,
          prompt: options.prompt,
          system: options.systemInstruction || undefined,
          options: {
            temperature: options.temperature ?? 0.7,
            num_predict: 4096,
          },
        });
        return response.response || '';
      });

      console.log(`[Ollama] Used model: ${modelName}`);
      return result;
    } catch (err: any) {
      lastError = err;
      console.warn(`[Ollama] Model ${modelName} failed: ${err.message?.substring(0, 100)}`);
    }
  }

  throw lastError || new Error('Semua model Ollama gagal');
}

/**
 * Check if Ollama API is available (has host configured)
 */
export function isAvailable(): boolean {
  return !!(process.env.OLLAMA_HOST || process.env.OLLAMA_API_KEY);
}

/**
 * List available models from Ollama server
 */
export async function listModels(): Promise<string[]> {
  try {
    const response = await getOllama().list();
    return response.models.map(m => m.name);
  } catch {
    return [];
  }
}
