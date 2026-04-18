// =====================================================================
// Gemini AI Utility — Wrapper for Google Generative AI (FREE)
// =====================================================================
// Replaces z-ai-web-dev-sdk for CasaOS deployment where Z.ai internal
// API is not accessible.
//
// Features:
// - Auto-retry on rate limit (429) with exponential backoff
// - Fallback to alternative models if primary is unavailable
// - Graceful error handling
// =====================================================================

import { GoogleGenerativeAI } from '@google/generative-ai';

let _genAI: GoogleGenerativeAI | null = null;

// Models to try in order (best quality first)
const MODEL_FALLBACKS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-8b',
];

function getGenAI(): GoogleGenerativeAI {
  if (_genAI) return _genAI;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Please add it to your .env file.\n' +
      'Get a free key at: https://aistudio.google.com/apikey'
    );
  }

  _genAI = new GoogleGenerativeAI(apiKey);
  return _genAI;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(err: any): boolean {
  const msg = err?.message || '';
  return (
    msg.includes('429') ||
    msg.includes('Too Many Requests') ||
    msg.includes('quota') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('503')
  );
}

function isModelNotFoundError(err: any): boolean {
  const msg = err?.message || '';
  return msg.includes('404') || msg.includes('not found') || msg.includes('not supported');
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
        console.warn(`[Gemini] ${modelName} rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Chat completion — drop-in replacement for z-ai-web-dev-sdk chat.completions.create()
 *
 * @param options.messages - Array of { role: 'system'|'user'|'assistant', content: string }
 * @param options.model - Gemini model name (auto-fallback if not specified)
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

  // Extract system messages (Gemini handles them separately)
  const systemMessages = options.messages.filter(m => m.role === 'system');
  const conversationMessages = options.messages.filter(m => m.role !== 'system');
  const combinedSystem = systemMessages.map(m => m.content).join('\n\n');

  // Build history from conversation
  const history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  let lastUserMessage = '';

  for (const msg of conversationMessages) {
    if (msg.role === 'user') {
      lastUserMessage = msg.content;
      if (history.length > 0 || conversationMessages.indexOf(msg) > 0) {
        history.push({ role: 'user', parts: [{ text: msg.content }] });
      }
    } else if (msg.role === 'assistant') {
      history.push({ role: 'model', parts: [{ text: msg.content }] });
    }
  }

  let lastError: any;

  for (const modelName of modelsToTry) {
    try {
      const model = getGenAI().getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxOutputTokens ?? 8192,
        },
      });

      const result = await tryWithRetries(modelName, async () => {
        const chat = model.startChat({
          history,
          ...(combinedSystem ? { systemInstruction: combinedSystem } : {}),
        });
        const response = await chat.sendMessage(lastUserMessage || 'Hello');
        return response.text();
      });

      return { content: result };
    } catch (err: any) {
      lastError = err;
      console.warn(`[Gemini] Model ${modelName} failed: ${err.message?.substring(0, 100)}`);
      // Continue to next model
    }
  }

  // All models failed
  const errMsg = lastError?.message || 'Unknown error';
  if (errMsg.includes('429') || errMsg.includes('quota')) {
    throw new Error(`Gemini API quota exceeded. Free tier limit reached. Please wait a moment or upgrade your plan at https://ai.google.dev. Original: ${errMsg.substring(0, 200)}`);
  }
  throw lastError || new Error('All Gemini models failed');
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
      const model = getGenAI().getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: 8192,
        },
        ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
      });

      const result = await tryWithRetries(modelName, async () => {
        const response = await model.generateContent(options.prompt);
        return response.text();
      });

      return result;
    } catch (err: any) {
      lastError = err;
      console.warn(`[Gemini] Model ${modelName} failed: ${err.message?.substring(0, 100)}`);
    }
  }

  throw lastError || new Error('All Gemini models failed');
}

/**
 * Check if Gemini API is available (has API key)
 */
export function isAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}
