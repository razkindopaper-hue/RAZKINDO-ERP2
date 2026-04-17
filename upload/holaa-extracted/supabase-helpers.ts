// =====================================================================
// SUPABASE HELPERS - Common utilities for API routes
// =====================================================================

/**
 * Convert camelCase to snake_case
 */
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert snake_case to camelCase
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert all keys in an object from snake_case to camelCase
 * Recursively handles nested objects and arrays
 *
 * FIX BUG-3: Return null (bukan {}) jika input null,
 * supaya null-check di caller (if (!userCamel)) berfungsi benar.
 */
export function toCamelCase<T = Record<string, any>>(row: Record<string, any> | null): T | null {
  if (!row) return null;
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = snakeToCamel(key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      result[camelKey] = toCamelCase(value);
    } else if (Array.isArray(value)) {
      result[camelKey] = value.map(item =>
        item !== null && typeof item === 'object' ? toCamelCase(item) : item
      );
    } else {
      result[camelKey] = value;
    }
  }
  return result as T;
}

/**
 * Convert all keys in an object from camelCase to snake_case
 * Recursively handles nested objects and arrays
 */
export function toSnakeCase(obj: Record<string, any>): Record<string, any> {
  if (!obj) return obj as any;
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = camelToSnake(key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      result[snakeKey] = toSnakeCase(value);
    } else if (Array.isArray(value)) {
      result[snakeKey] = value.map(item =>
        item !== null && typeof item === 'object' ? toSnakeCase(item) : item
      );
    } else {
      result[snakeKey] = value;
    }
  }
  return result;
}

/**
 * Convert an array of rows from snake_case to camelCase
 */
export function rowsToCamelCase<T = Record<string, any>>(rows: Record<string, any>[]): T[] {
  return rows.map(row => toCamelCase(row)) as T[];
}

/**
 * Map Prisma-style camelCase select to Supabase comma-separated string
 */
export function mapSelect(select: Record<string, boolean>): string {
  return Object.keys(select)
    .filter((key) => select[key])
    .map(camelToSnake)
    .join(', ');
}

/**
 * Generate a CUID-like ID (for compatibility with existing data)
 */
export function generateId(): string {
  // Use crypto.randomUUID() which is available in Node.js 19+
  return crypto.randomUUID();
}

/**
 * Helper to create a log entry (fire-and-forget)
 */
export async function createLog(
  db: any,
  data: {
    type: string;
    userId?: string;
    action: string;
    entity?: string;
    entityId?: string;
    payload?: any;
    message?: string;
  }
) {
  try {
    await db.from('logs').insert({
      type: data.type,
      user_id: data.userId || null,
      action: data.action,
      entity: data.entity || null,
      entity_id: data.entityId || null,
      payload: data.payload ? (typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload)) : null,
      message: data.message || null,
    });
  } catch (err) {
    console.error('[Log] Failed to create log:', err);
  }
}

/**
 * Helper to create an event entry (fire-and-forget)
 * Also triggers push notification to subscribed devices
 */
export async function createEvent(
  db: any,
  type: string,
  payload: any
) {
  try {
    await db.from('events').insert({
      type,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });

    // Send push notification for this event (fire-and-forget, non-blocking)
    try {
      const { sendEventPush } = await import('@/lib/push-notification');
      sendEventPush(type, payload);
    } catch {
      // Push notification failure should not affect event creation
    }
  } catch (err) {
    console.error('[Event] Failed to create event:', err);
  }
}

/**
 * Build Supabase filter from a Prisma-style where clause
 * Supports: eq, neq, gt, gte, lt, lte, in, contains, ilike
 */
export function buildFilters(query: any, where: Record<string, any>): any {
  for (const [key, value] of Object.entries(where)) {
    const snakeKey = camelToSnake(key);
    
    if (value === undefined || value === null) continue;
    
    if (typeof value === 'object' && !Array.isArray(value)) {
      // Handle operators like { gte: date, lte: date }
      if (value.gte !== undefined) {
        query = query.gte(snakeKey, value.gte instanceof Date ? value.gte.toISOString() : value.gte);
      }
      if (value.gt !== undefined) {
        query = query.gt(snakeKey, value.gt instanceof Date ? value.gt.toISOString() : value.gt);
      }
      if (value.lte !== undefined) {
        query = query.lte(snakeKey, value.lte instanceof Date ? value.lte.toISOString() : value.lte);
      }
      if (value.lt !== undefined) {
        query = query.lt(snakeKey, value.lt instanceof Date ? value.lt.toISOString() : value.lt);
      }
      if (value.in !== undefined) {
        query = query.in(snakeKey, value.in);
      }
      if (value.contains !== undefined) {
        query = query.ilike(snakeKey, `%${value.contains}%`);
      }
    } else {
      query = query.eq(snakeKey, value);
    }
  }
  return query;
}

/**
 * Generate invoice number
 */
export function generateInvoiceNo(type: string, count: number): string {
  const now = new Date();
  const prefix = type === 'sale' ? 'INV' : type === 'purchase' ? 'PO' : type === 'expense' ? 'EXP' : 'TRX';
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}${month}${String(count + 1).padStart(4, '0')}`;
}
