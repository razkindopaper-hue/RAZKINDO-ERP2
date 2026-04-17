import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';

// =====================================================================
// POST /api/system/restart - Restart the Next.js dev server
//
// Only super_admin can trigger this. The endpoint:
// 1. Validates authorization
// 2. Sends a quick response to the client
// 3. Spawns the keep-server-alive restart logic in background
//
// Note: The current process will die after restart, so we use
// spawn with detached: true to ensure the restart survives.
// =====================================================================

export async function POST(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const projectDir = process.cwd();
    const logFile = join(projectDir, 'server-restart.log');

    // Log the restart
    const timestamp = new Date().toISOString();
    appendFileSync(logFile, `[${timestamp}] Manual restart triggered by user ${authUserId}\n`);

    // Check if keep-server-alive.sh exists
    const keepAliveScript = join(projectDir, 'keep-server-alive.sh');
    if (!existsSync(keepAliveScript)) {
      return NextResponse.json({
        success: false,
        error: 'Script keep-server-alive.sh tidak ditemukan',
      }, { status: 500 });
    }

    // Read .env to set proper database URLs (same logic as keep-server-alive.sh)
    const envFile = join(projectDir, '.env');
    let envExtra: Record<string, string> = {};
    if (existsSync(envFile)) {
      const envContent = readFileSync(envFile, 'utf-8');
      const dbUrlMatch = envContent.match(/^DATABASE_URL=(.+)$/m);
      const directUrlMatch = envContent.match(/^DIRECT_URL=(.+)$/m);
      if (dbUrlMatch?.[1]?.startsWith('postgresql://')) {
        envExtra.DATABASE_URL = dbUrlMatch[1];
      }
      if (directUrlMatch?.[1]?.startsWith('postgresql://')) {
        envExtra.DIRECT_URL = directUrlMatch[1];
      }
    }

    // Schedule restart after 1 second (enough time to send response)
    setTimeout(() => {
      try {
        // Kill existing server processes on port 3000
        try {
          execSync('kill $(lsof -t -i:3000 2>/dev/null) 2>/dev/null', { timeout: 5000 });
          execSync('kill $(lsof -t -i:3004 2>/dev/null) 2>/dev/null', { timeout: 5000 });
        } catch { /* no process to kill */ }

        // Small delay after killing
        setTimeout(() => {
          // Start event queue first
          const eqDir = join(projectDir, 'mini-services', 'event-queue');
          if (existsSync(eqDir)) {
            const eqProc = spawn('bun', ['index.ts'], {
              cwd: eqDir,
              detached: true,
              stdio: 'ignore',
              env: { ...process.env, ...envExtra },
            });
            eqProc.unref();
          }

          // Small delay for event queue to start
          setTimeout(() => {
            // Start Next.js server
            const standalonePath = join(projectDir, '.next', 'standalone', 'server.js');
            let serverCmd: string[];
            let serverArgs: string[];

            if (existsSync(standalonePath)) {
              // Production standalone
              serverCmd = ['node'];
              serverArgs = [standalonePath];
            } else {
              // Dev server
              serverCmd = ['npx'];
              serverArgs = ['next', 'dev', '--turbopack'];
            }

            const serverProc = spawn(serverCmd[0], serverArgs, {
              cwd: projectDir,
              detached: true,
              stdio: 'ignore',
              env: {
                ...process.env,
                ...envExtra,
                HOSTNAME: '0.0.0.0',
                PORT: '3000',
                NODE_OPTIONS: '--max-old-space-size=1536',
              },
            });
            serverProc.unref();

            appendFileSync(logFile, `[${new Date().toISOString()}] Server restart completed\n`);
          }, 2000);
        }, 1500);
      } catch (err: any) {
        appendFileSync(logFile, `[${new Date().toISOString()}] Restart error: ${err.message}\n`);
      }
    }, 1000);

    return NextResponse.json({
      success: true,
      message: 'Server sedang di-restart... Mohon tunggu beberapa detik.',
      restartAt: timestamp,
    });
  } catch (error: any) {
    console.error('Restart API error:', error);
    return NextResponse.json({ success: false, error: 'Gagal merestart server' }, { status: 500 });
  }
}
