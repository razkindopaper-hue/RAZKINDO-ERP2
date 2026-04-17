import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { toCamelCase, rowsToCamelCase, generateId } from '@/lib/supabase-helpers';
import { createLog } from '@/lib/supabase-helpers';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { validateBody, authSchemas } from '@/lib/validators';
import { enforceSuperAdmin } from '@/lib/require-auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email: rawEmail, password, name, phone, role, unitId, unitIds, customRoleId } = body;
    const normalizedEmail = (rawEmail || '').toLowerCase().trim();

    // ============ NON-ERP EMPLOYEE (custom role) ============
    // Requires super_admin authentication — only admins can create non-ERP employees
    if (customRoleId) {
      const authResult = await enforceSuperAdmin(request);
      if (!authResult.success) return authResult.response;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'Nama wajib diisi' }, { status: 400 });
      }

      // Verify custom role exists
      const { data: customRole } = await db
        .from('custom_roles')
        .select('*')
        .eq('id', customRoleId)
        .single();
      if (!customRole) {
        return NextResponse.json({ error: 'Role kustom tidak ditemukan' }, { status: 400 });
      }

      // Auto-generate internal email (unique, not login-able)
      const internalEmail = `${customRole.name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}@internal.no-login`;

      // Random password (user can never log in with it)
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPassword, 12);

      // Normalize unitIds
      const selectedUnitIds: string[] = Array.isArray(unitIds)
        ? unitIds.filter((id: string) => id && id.trim())
        : (unitId ? [unitId] : []);
      const primaryUnitId = selectedUnitIds.length > 0 ? selectedUnitIds[0] : null;

      // users table uses snake_case columns — id has no DB default, must generate explicitly
      const { data: user, error: insertError } = await db
        .from('users')
        .insert({
          id: generateId(),
          email: internalEmail,
          password: hashedPassword,
          name: name.trim(),
          phone: phone || null,
          role: customRole.name,
          custom_role_id: customRoleId,
          unit_id: primaryUnitId,
          status: 'approved',
          can_login: false,
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (insertError) {
        console.error('[Register] Non-ERP insert error:', insertError);
        throw insertError;
      }

      const userCamel = toCamelCase(user);

      // user_units table uses snake_case columns
      if (selectedUnitIds.length > 0 && userCamel.id) {
        try {
          await db.from('user_units').insert(
            selectedUnitIds.map((uid: string) => ({ user_id: userCamel.id, unit_id: uid }))
          );
        } catch (uuErr: any) {
          console.warn('[Register] user_units insert failed:', uuErr.message);
        }
      }

      // Fetch user units
      let userUnits: any[] = [];
      try {
        const { data: uuData } = await db
          .from('user_units')
          .select('*')
          .eq('user_id', userCamel.id);
        if (uuData) userUnits = rowsToCamelCase(uuData);
      } catch {}

      createLog(db, {
        type: 'activity',
        userId: userCamel.id,
        action: 'register_non_erp',
        message: `Non-ERP employee created: ${name} (${customRole.name})`
      });

      const { password: _, ...userWithoutPassword } = userCamel!;
      return NextResponse.json({
        user: { ...userWithoutPassword, userUnits, customRole: toCamelCase(customRole) }
      });
    }

    // ============ ERP USER (standard registration) ============
    // Zod validates: name (required), email (format), password (min 6), role (enum), unitId, unitIds, customRoleId
    const erpValidation = validateBody(authSchemas.register, body);
    if (!erpValidation.success) {
      return NextResponse.json({ error: erpValidation.error }, { status: 400 });
    }
    const { email: validatedEmail, password: validatedPassword, name: validatedName, role: validatedRole, unitId: validatedUnitId, unitIds: validatedUnitIds, phone: validatedPhone } = erpValidation.data;

    // Normalize email
    const email = validatedEmail.toLowerCase().trim();

    // Normalize unitIds: accept both unitId (single, backward compat) and unitIds (array)
    const selectedUnitIds: string[] = Array.isArray(validatedUnitIds)
      ? validatedUnitIds.filter((id: string) => id && id.trim())
      : (validatedUnitId ? [validatedUnitId] : []);

    // For non-admin roles, at least 1 unit is required
    if (validatedRole !== 'super_admin' && selectedUnitIds.length === 0) {
      return NextResponse.json(
        { error: 'Pilih minimal 1 unit/cabang' },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(validatedPassword, 12);

    try {
      // Check super_admin existence
      if (validatedRole === 'super_admin') {
        const { count: existingSuperAdmin } = await db
          .from('users')
          .select('*', { count: 'exact', head: true })
          .eq('role', 'super_admin');
        if (existingSuperAdmin && existingSuperAdmin > 0) {
          return NextResponse.json(
            { error: 'Super Admin sudah terdaftar. Hubungi administrator.' },
            { status: 400 }
          );
        }
      }

      // Determine status
      let status: string;
      if (validatedRole === 'super_admin') {
        status = 'approved';
      } else {
        const { count: superAdminCount } = await db
          .from('users')
          .select('*', { count: 'exact', head: true })
          .eq('role', 'super_admin')
          .eq('status', 'approved');
        status = superAdminCount && superAdminCount > 0 ? 'pending' : 'approved';
      }

      // Set primary unit_id to first selected unit (backward compat)
      const primaryUnitId = selectedUnitIds.length > 0 ? selectedUnitIds[0] : null;

      // users table uses snake_case columns — id has no DB default, must generate explicitly
      const { data: user, error: insertError } = await db
        .from('users')
        .insert({
          id: generateId(),
          email,
          password: hashedPassword,
          name: validatedName,
          phone: validatedPhone || null,
          role: validatedRole,
          unit_id: primaryUnitId,
          status,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (insertError) {
        if (insertError.code === '23505') {
          return NextResponse.json(
            { error: 'Email sudah terdaftar' },
            { status: 400 }
          );
        }
        throw insertError;
      }

      const userCamel = toCamelCase(user);

      // Insert into user_units junction table (snake_case columns)
      if (selectedUnitIds.length > 0 && userCamel.id) {
        const userUnitRows = selectedUnitIds.map((unitId: string) => ({
          user_id: userCamel.id,
          unit_id: unitId,
        }));

        try {
          await db.from('user_units').insert(userUnitRows);
        } catch (uuErr: any) {
          console.warn('[Register] user_units insert failed:', uuErr.message);
        }
      }

      // Fetch user with their assigned units
      let userUnits: any[] = [];
      try {
        const { data: uuData } = await db
          .from('user_units')
          .select('*')
          .eq('user_id', userCamel.id);
        if (uuData) {
          userUnits = rowsToCamelCase(uuData);
        }
      } catch {
        // user_units table may not exist
      }

      // Create log
      createLog(db, {
        type: 'activity',
        userId: userCamel.id,
        action: 'register',
        message: `New user registered: ${validatedName} (${validatedRole}) — units: ${selectedUnitIds.join(', ') || 'none'}`
      });

      const { password: _, ...userWithoutPassword } = userCamel!;

      return NextResponse.json({
        user: {
          ...userWithoutPassword,
          userUnits,
        }
      });
    } catch (error: any) {
      if (error?.status === 400) return error;
      throw error;
    }
  } catch (error) {
    console.error('Register error:', error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
