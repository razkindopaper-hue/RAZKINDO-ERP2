import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase } from '@/lib/supabase-helpers';
import { createLog } from '@/lib/supabase-helpers';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getAuthSecret } from '@/lib/auth-secret';
import { invalidateUserAuthCache } from '@/lib/token';
import { validateBody, authSchemas } from '@/lib/validators';

// ================================
// RATE LIMITING - In-memory login attempt tracker
// ================================
interface RateLimitEntry {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

const _loginAttempts = new Map<string, RateLimitEntry>();
const MAX_ATTEMPTS = 10;           // Max login attempts per window
const WINDOW_MS = 15 * 60 * 1000;  // 15 minute window
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minute lockout after max attempts

function cleanExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of _loginAttempts) {
    if (now > entry.firstAttemptAt + WINDOW_MS && now > entry.lockedUntil) {
      _loginAttempts.delete(key);
    }
  }
}

function checkRateLimit(email: string): { allowed: boolean; retryAfter?: number } {
  cleanExpiredEntries();

  const entry = _loginAttempts.get(email);
  if (!entry) return { allowed: true };

  const now = Date.now();

  // Check if locked out
  if (now < entry.lockedUntil) {
    return {
      allowed: false,
      retryAfter: Math.ceil((entry.lockedUntil - now) / 1000)
    };
  }

  // Reset window if expired
  if (now > entry.firstAttemptAt + WINDOW_MS) {
    _loginAttempts.delete(email);
    return { allowed: true };
  }

  return { allowed: entry.attempts < MAX_ATTEMPTS };
}

function recordFailedAttempt(email: string) {
  const now = Date.now();
  const entry = _loginAttempts.get(email);

  if (!entry || now > entry.firstAttemptAt + WINDOW_MS) {
    _loginAttempts.set(email, {
      attempts: 1,
      firstAttemptAt: now,
      lockedUntil: 0
    });
  } else {
    entry.attempts += 1;
    // Lock out after max attempts
    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.lockedUntil = now + LOCKOUT_MS;
    }
  }
}

function clearFailedAttempts(email: string) {
  _loginAttempts.delete(email);
}

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _loginAttempts.entries()) {
    if (now > entry.lockedUntil + 60_000) _loginAttempts.delete(key);
  }
}, 300_000);

// ================================
// LOGIN HANDLER
// ================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = validateBody(authSchemas.login, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { email, password } = validation.data;

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Rate limit check
    const rateCheck = checkRateLimit(normalizedEmail);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: `Terlalu banyak percobaan login. Coba lagi dalam ${rateCheck.retryAfter} detik.` },
        { status: 429 }
      );
    }

    // Use left join (no !) for unit so stale unit_id doesn't break the query
    // maybeSingle returns null instead of error when no row found
    const { data: user, error: dbError } = await db
      .from('users')
      .select('*, unit:units(*)')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (dbError) {
      console.error('[Login] DB error:', dbError.message, dbError.code);
      return NextResponse.json(
        { error: 'Terjadi kesalahan server' },
        { status: 500 }
      );
    }

    const userCamel = toCamelCase(user);

    // Use same error message for not found + not approved + non-ERP to prevent email enumeration
    if (!userCamel || userCamel.status !== 'approved' || !userCamel.isActive || userCamel.canLogin === false) {
      recordFailedAttempt(normalizedEmail);
      return NextResponse.json(
        { error: 'Email atau password salah' },
        { status: 401 }
      );
    }

    const isValidPassword = await bcrypt.compare(password, userCamel.password as string);

    if (!isValidPassword) {
      recordFailedAttempt(normalizedEmail);
      return NextResponse.json(
        { error: 'Email atau password salah' },
        { status: 401 }
      );
    }

    // Clear failed attempts on successful login
    clearFailedAttempts(normalizedEmail);

    // Update last seen
    await db
      .from('users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', userCamel.id);

    // Create log (fire-and-forget)
    createLog(db, {
      type: 'activity',
      userId: userCamel.id,
      action: 'login',
      message: `${userCamel.name} logged in`
    });

    const { password: _, ...userWithoutPassword } = userCamel!;
    
    // Generate secure token with HMAC signature
    const payload = `${userCamel.id}:${Date.now()}`;
    const signature = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('hex');
    const token = Buffer.from(`${payload}:${signature}`).toString('base64');

    return NextResponse.json({
      user: userWithoutPassword,
      token
    });
  } catch (error: any) {
    console.error('[Login] Server error:', error?.message || error);
    // Don't expose internal errors to the client
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
