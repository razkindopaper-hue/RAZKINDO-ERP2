import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // --- CPU Load ---
    let cpuPercent = 0;
    let cpuCores = 1;
    let loadAvg: number[] = [0, 0, 0];
    try {
      // Read /proc/stat for CPU usage (two samples 200ms apart)
      const readCpu = (): number[] => {
        const stat = readFileSync('/proc/stat', 'utf-8');
        const line = stat.split('\n')[0];
        const parts = line.split(/\s+/).slice(1).map(Number);
        return parts; // [user, nice, system, idle, iowait, irq, softirq, steal]
      };
      const c1 = readCpu();
      await new Promise(r => setTimeout(r, 200));
      const c2 = readCpu();
      const d1 = c1.reduce((a, b) => a + b, 0);
      const d2 = c2.reduce((a, b) => a + b, 0);
      const idleDiff = (c2[3] + (c2[4] || 0)) - (c1[3] + (c1[4] || 0));
      const totalDiff = d2 - d1;
      cpuPercent = totalDiff > 0 ? Math.round(((totalDiff - idleDiff) / totalDiff) * 100) : 0;

      // CPU cores
      cpuCores = readFileSync('/proc/cpuinfo', 'utf-8').split('\n').filter(l => l.startsWith('processor')).length || 1;

      // Load average
      loadAvg = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/).slice(0, 3).map(Number);
    } catch {
      try {
        // macOS fallback
        const topOut = execSync('top -l 1 -n 0 | head -10', { encoding: 'utf-8', timeout: 5000 });
        const cpuMatch = topOut.match(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/);
        if (cpuMatch) cpuPercent = Math.round(parseFloat(cpuMatch[1]) + parseFloat(cpuMatch[2]));
      } catch { /* fallback to 0 */ }
    }

    // --- Memory ---
    let memTotal = 0; let memUsed = 0; let memAvailable = 0; let memPercent = 0;
    let swapTotal = 0; let swapUsed = 0;
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf-8');
      const parseMemField = (field: string): number => {
        const match = meminfo.match(new RegExp(`${field}:\\s+(\\d+)`));
        return match ? parseInt(match[1]) : 0; // in kB
      };
      memTotal = parseMemField('MemTotal');
      memAvailable = parseMemField('MemAvailable');
      memUsed = memTotal - memAvailable;
      memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
      swapTotal = parseMemField('SwapTotal');
      swapUsed = swapTotal - parseMemField('SwapFree');
    } catch {
      try {
        const vmStat = execSync('vm_stat', { encoding: 'utf-8', timeout: 5000 });
        const pageSize = 4096;
        const freePages = parseInt(vmStat.match(/Pages free:\s+(\d+)/)?.[1] || '0');
        const activePages = parseInt(vmStat.match(/Pages active:\s+(\d+)/)?.[1] || '0');
        const inactivePages = parseInt(vmStat.match(/Pages inactive:\s+(\d+)/)?.[1] || '0');
        const wiredPages = parseInt(vmStat.match(/Pages wired down:\s+(\d+)/)?.[1] || '0');
        memTotal = Math.round((freePages + activePages + inactivePages + wiredPages) * pageSize / 1024);
        memUsed = Math.round((activePages + wiredPages) * pageSize / 1024);
        memAvailable = Math.round((freePages + inactivePages) * pageSize / 1024);
        memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
      } catch { /* fallback */ }
    }

    // --- Node.js Process Memory ---
    const nodeMem = process.memoryUsage();

    // --- Uptime ---
    const uptimeSeconds = Math.floor(process.uptime());

    // --- Process Info ---
    let processInfo = { pid: process.pid, ppid: 0, threads: 1 };
    try {
      const statContent = readFileSync(`/proc/${process.pid}/stat`, 'utf-8');
      const parts = statContent.split(/\s+/);
      processInfo.ppid = parseInt(parts[3]) || 0;
      processInfo.threads = parseInt(parts[19]) || 1;
    } catch { /* fallback */ }

    // --- Active connections / HTTP requests ---
    let activeConnections = 0;
    try {
      const ssOut = execSync('ss -tunp 2>/dev/null | grep -c ":3000"', { encoding: 'utf-8', timeout: 3000 });
      activeConnections = parseInt(ssOut.trim()) || 0;
    } catch { /* fallback */ }

    return NextResponse.json({
      success: true,
      data: {
        cpu: {
          percent: cpuPercent,
          cores: cpuCores,
          loadAvg,
        },
        memory: {
          total: memTotal, // kB
          used: memUsed,
          available: memAvailable,
          percent: memPercent,
          swapTotal,
          swapUsed,
        },
        nodeMemory: {
          rss: Math.round(nodeMem.rss / 1024), // kB
          heapTotal: Math.round(nodeMem.heapTotal / 1024),
          heapUsed: Math.round(nodeMem.heapUsed / 1024),
          external: Math.round(nodeMem.external / 1024),
          arrayBuffers: Math.round(nodeMem.arrayBuffers / 1024),
        },
        uptime: uptimeSeconds,
        process: processInfo,
        activeConnections,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('System stats error:', error);
    return NextResponse.json({ success: false, error: 'Gagal mengambil stats sistem' }, { status: 500 });
  }
}
