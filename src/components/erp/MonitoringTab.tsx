'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Cpu,
  HardDrive,
  Database,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Clock,
  Server,
  ShieldCheck,
  MemoryStick,
  Activity,
  Wifi,
  WifiOff,
  Zap,
  Timer,
  ArrowDown,
  ArrowUp,
  Minus,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { apiFetch } from '@/lib/api-client';

// ===== TYPES =====
interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  cpuUsage: number;
  loadAvg: number[];
  totalMemory: number;
  usedMemory: number;
  freeMemory: number;
  memoryUsagePercent: number;
  disk: { total: number; used: number; available: number; usagePercent: number };
  uptime: number;
  isDocker: boolean;
}

interface TableInfo {
  name: string;
  label: string;
  rows: number;
  safeToDelete: boolean;
  canCleanOld: boolean;
}

interface MonitoringData {
  system: SystemInfo;
  supabase: {
    tables: TableInfo[];
    totalRows: number;
  };
}

interface RealtimeMetrics {
  timestamp: number;
  cpu: {
    usage: number;
    cores: number;
    model: string;
    loadAvg: number[];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
  };
  supabase: {
    readMs: number;
    writeMs: number;
    status: 'healthy' | 'degraded' | 'down';
    error?: string;
  };
  uptime: number;
  process: {
    memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
    pid: number;
  };
}

// ===== HELPERS =====
function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('id-ID').format(n);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}h ${hours}j ${minutes}m`;
  if (hours > 0) return `${hours}j ${minutes}m`;
  return `${minutes}m`;
}

function getUsageColor(percent: number): string {
  if (percent >= 90) return 'text-red-500';
  if (percent >= 70) return 'text-orange-500';
  if (percent >= 50) return 'text-yellow-500';
  return 'text-green-500';
}

function getUsageProgressColor(percent: number): string {
  if (percent >= 90) return '[&>div]:bg-red-500 [&>div]:shadow-[0_0_8px_rgba(239,68,68,0.4)]';
  if (percent >= 70) return '[&>div]:bg-orange-500 [&>div]:shadow-[0_0_8px_rgba(249,115,22,0.4)]';
  if (percent >= 50) return '[&>div]:bg-yellow-500 [&>div]:shadow-[0_0_8px_rgba(234,179,8,0.4)]';
  return '[&>div]:bg-green-500 [&>div]:shadow-[0_0_8px_rgba(34,197,94,0.4)]';
}

function getLatencyColor(ms: number): string {
  if (ms < 0) return 'text-red-500'; // error
  if (ms < 100) return 'text-green-500';
  if (ms < 300) return 'text-yellow-500';
  if (ms < 700) return 'text-orange-500';
  return 'text-red-500';
}

function getLatencyBg(ms: number): string {
  if (ms < 0) return 'bg-red-500/10 border-red-200 dark:border-red-800';
  if (ms < 100) return 'bg-green-500/10 border-green-200 dark:border-green-800';
  if (ms < 300) return 'bg-yellow-500/10 border-yellow-200 dark:border-yellow-800';
  if (ms < 700) return 'bg-orange-500/10 border-orange-200 dark:border-orange-800';
  return 'bg-red-500/10 border-red-200 dark:border-red-800';
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'healthy':
      return <Badge className="bg-green-500/15 text-green-600 border-green-300 dark:border-green-800 dark:text-green-400"><Wifi className="w-3 h-3 mr-1" />Sehat</Badge>;
    case 'degraded':
      return <Badge className="bg-yellow-500/15 text-yellow-600 border-yellow-300 dark:border-yellow-800 dark:text-yellow-400"><Activity className="w-3 h-3 mr-1" />Lambat</Badge>;
    case 'down':
      return <Badge className="bg-red-500/15 text-red-600 border-red-300 dark:border-red-800 dark:text-red-400"><WifiOff className="w-3 h-3 mr-1" />Putus</Badge>;
    default:
      return null;
  }
}

// ===== CIRCULAR GAUGE COMPONENT =====
function CircularGauge({ value, label, icon: Icon, size = 100 }: {
  value: number;
  label: string;
  icon: React.ElementType;
  size?: number;
}) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedValue = Math.min(100, Math.max(0, value));
  const offset = circumference - (clampedValue / 100) * circumference;

  let strokeColor = '#22c55e'; // green
  if (clampedValue >= 90) strokeColor = '#ef4444'; // red
  else if (clampedValue >= 70) strokeColor = '#f97316'; // orange
  else if (clampedValue >= 50) strokeColor = '#eab308'; // yellow

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg className="transform -rotate-90" width={size} height={size}>
          {/* Background circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="currentColor"
            className="text-muted/30"
            strokeWidth="6"
            fill="none"
          />
          {/* Value arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={strokeColor}
            strokeWidth="6"
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.5s ease-out, stroke 0.3s ease' }}
          />
        </svg>
        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Icon className="w-4 h-4 text-muted-foreground mb-0.5" />
          <span className={`text-lg font-bold leading-none ${getUsageColor(clampedValue)}`}>
            {Math.round(clampedValue)}%
          </span>
        </div>
      </div>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

// ===== SPARKLINE MINI CHART =====
function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const width = 120;
  const height = 32;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} className="opacity-60">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ===== MAIN COMPONENT =====
export default function MonitoringTab() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const isSuperAdmin = user?.role === 'super_admin';

  // Cleanup state
  const [selectedTable, setSelectedTable] = useState('');
  const [selectedDays, setSelectedDays] = useState('90');
  const [cleanupMode, setCleanupMode] = useState<'old' | 'all'>('old');
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);

  // Realtime metrics state
  const [realtimeEnabled, setRealtimeEnabled] = useState(true);
  const [metrics, setMetrics] = useState<RealtimeMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const metricsRef = useRef<RealtimeMetrics[]>([]); // history for sparklines
  const fetchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch realtime metrics
  const fetchMetrics = useCallback(async () => {
    try {
      setMetricsError(null);
      const data = await apiFetch<RealtimeMetrics>('/api/system/metrics');
      setMetrics(data);
      // Keep last 60 data points (60 seconds)
      metricsRef.current = [...metricsRef.current.slice(-59), data];
    } catch (err: any) {
      setMetricsError(err?.message || 'Gagal mengambil metrik');
    }
  }, []);

  // Auto-refresh every 1 second
  useEffect(() => {
    if (!isSuperAdmin || !realtimeEnabled) {
      if (fetchIntervalRef.current) {
        clearInterval(fetchIntervalRef.current);
        fetchIntervalRef.current = null;
      }
      return;
    }

    fetchMetrics(); // immediate first fetch
    fetchIntervalRef.current = setInterval(fetchMetrics, 1000);

    return () => {
      if (fetchIntervalRef.current) {
        clearInterval(fetchIntervalRef.current);
      }
    };
  }, [isSuperAdmin, realtimeEnabled, fetchMetrics]);

  // Fetch monitoring data (heavy, 30s interval)
  const { data, isLoading, isRefetching, refetch } = useQuery<MonitoringData>({
    queryKey: ['system-info'],
    queryFn: () => apiFetch<MonitoringData>('/api/system/info'),
    refetchInterval: 30000,
    enabled: isSuperAdmin,
  });

  // Sparkline data
  const cpuHistory = metricsRef.current.map(m => m.cpu.usage);
  const memHistory = metricsRef.current.map(m => m.memory.usagePercent);
  const latencyHistory = metricsRef.current.map(m => m.supabase.readMs >= 0 ? m.supabase.readMs : 0);

  if (!isSuperAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <ShieldCheck className="w-16 h-16 text-muted-foreground/30 mb-4" />
        <h3 className="text-lg font-semibold text-muted-foreground">Akses Terbatas</h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          Fitur monitoring hanya tersedia untuk Super Admin.
        </p>
      </div>
    );
  }

  const sys = data?.system;
  const supa = data?.supabase;
  const safeToDeleteTables = supa?.tables.filter(t => t.safeToDelete) || [];
  const canCleanOldTables = supa?.tables.filter(t => t.canCleanOld || t.safeToDelete) || [];

  // Execute cleanup
  const handleCleanup = async () => {
    if (!selectedTable) {
      toast.error('Pilih tabel terlebih dahulu');
      return;
    }
    setCleanupLoading(true);
    setShowConfirmDialog(false);
    try {
      const result = await apiFetch<{ success: boolean; message: string; deletedRows?: number; remainingRows?: number }>('/api/system/cleanup', {
        method: 'POST',
        body: JSON.stringify({
          table: selectedTable,
          mode: cleanupMode,
          olderThanDays: parseInt(selectedDays),
        }),
      });

      if (result.success) {
        toast.success(result.message);
        setSelectedTable('');
        queryClient.invalidateQueries({ queryKey: ['system-info'] });
        refetch();
      } else {
        toast.error(result.message);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Gagal membersihkan data');
    } finally {
      setCleanupLoading(false);
    }
  };

  const selectedTableInfo = supa?.tables.find(t => t.name === selectedTable);

  return (
    <div className="space-y-4">
      {/* Header with refresh & toggle */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="w-5 h-5" />
            Monitoring Sistem
          </h2>
          <p className="text-sm text-muted-foreground">
            Pantau resource server & koneksi database real-time
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Switch
              id="realtime-toggle"
              checked={realtimeEnabled}
              onCheckedChange={setRealtimeEnabled}
            />
            <label htmlFor="realtime-toggle" className="text-muted-foreground flex items-center gap-1">
              <Zap className={`w-3 h-3 ${realtimeEnabled ? 'text-yellow-500' : 'text-muted-foreground'}`} />
              <span className="hidden sm:inline">Real-time</span>
            </label>
          </div>
          <Button variant="outline" size="sm" onClick={() => { refetch(); fetchMetrics(); }} disabled={isRefetching}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ===== REALTIME GAUGES ===== */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Resource Real-time
                {realtimeEnabled && (
                  <span className="flex items-center gap-1 text-xs font-normal text-green-500 ml-2">
                    <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                    Live
                  </span>
                )}
              </CardTitle>
              <CardDescription>
                Update {realtimeEnabled ? 'setiap 1 detik' : 'manual'} — {sys?.hostname || '...'}
                {sys?.isDocker && <Badge variant="outline" className="text-xs ml-1">Docker</Badge>}
              </CardDescription>
            </div>
            {metrics && (
              <Badge variant="outline" className="text-xs font-mono">
                <Clock className="w-3 h-3 mr-1" />
                {new Date(metrics.timestamp).toLocaleTimeString('id-ID')}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {metricsError ? (
            <div className="p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{metricsError}</p>
              <Button variant="outline" size="sm" onClick={fetchMetrics} className="mt-2">
                Coba Lagi
              </Button>
            </div>
          ) : metrics ? (
            <div className="space-y-5">
              {/* Gauges Row */}
              <div className="flex items-center justify-around gap-4 flex-wrap">
                <CircularGauge
                  value={metrics.cpu.usage}
                  label="CPU"
                  icon={Cpu}
                  size={110}
                />
                <CircularGauge
                  value={metrics.memory.usagePercent}
                  label="RAM"
                  icon={MemoryStick}
                  size={110}
                />
                <div className="flex flex-col items-center gap-1">
                  <div className="relative w-[110px] h-[110px] rounded-full border-4 border-dashed flex flex-col items-center justify-center"
                    style={{
                      borderColor: metrics.supabase.status === 'healthy' ? '#22c55e'
                        : metrics.supabase.status === 'degraded' ? '#eab308'
                        : '#ef4444'
                    }}
                  >
                    <Timer className="w-4 h-4 text-muted-foreground mb-0.5" />
                    <span className={`text-lg font-bold leading-none ${getLatencyColor(metrics.supabase.readMs)}`}>
                      {metrics.supabase.readMs >= 0 ? metrics.supabase.readMs : '—'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">ms</span>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">Latensi DB</span>
                </div>
              </div>

              {/* CPU Detail */}
              <div className="space-y-2 p-3 border rounded-lg bg-muted/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">CPU</span>
                    <Badge variant="outline" className="text-xs">{metrics.cpu.cores} core</Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    <MiniSparkline data={cpuHistory} color={metrics.cpu.usage >= 70 ? '#ef4444' : metrics.cpu.usage >= 50 ? '#eab308' : '#22c55e'} />
                    <span className={`text-sm font-bold ${getUsageColor(metrics.cpu.usage)}`}>{metrics.cpu.usage}%</span>
                  </div>
                </div>
                <Progress value={metrics.cpu.usage} className={`h-2 ${getUsageProgressColor(metrics.cpu.usage)}`} />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{metrics.cpu.model}</span>
                  <span>Load: {metrics.cpu.loadAvg[0]} / {metrics.cpu.loadAvg[1]} / {metrics.cpu.loadAvg[2]}</span>
                </div>
              </div>

              {/* RAM Detail */}
              <div className="space-y-2 p-3 border rounded-lg bg-muted/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MemoryStick className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">RAM</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <MiniSparkline data={memHistory} color={metrics.memory.usagePercent >= 70 ? '#ef4444' : metrics.memory.usagePercent >= 50 ? '#eab308' : '#22c55e'} />
                    <span className={`text-sm font-bold ${getUsageColor(metrics.memory.usagePercent)}`}>{metrics.memory.usagePercent}%</span>
                  </div>
                </div>
                <Progress value={metrics.memory.usagePercent} className={`h-2 ${getUsageProgressColor(metrics.memory.usagePercent)}`} />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Terpakai: {formatBytes(metrics.memory.used)}</span>
                  <span>Total: {formatBytes(metrics.memory.total)}</span>
                  <span>Bebas: {formatBytes(metrics.memory.free)}</span>
                </div>
              </div>

              {/* Supabase Latency Detail */}
              <div className={`space-y-3 p-3 border rounded-lg ${getLatencyBg(metrics.supabase.readMs)}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Latensi Supabase</span>
                    {getStatusBadge(metrics.supabase.status)}
                  </div>
                </div>

                {metrics.supabase.error ? (
                  <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{metrics.supabase.error}</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {/* Read Latency */}
                    <div className="space-y-1 p-2.5 bg-background/50 rounded-lg">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Read Query</span>
                        <span className={`text-sm font-bold ${getLatencyColor(metrics.supabase.readMs)}`}>
                          {metrics.supabase.readMs} ms
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {metrics.supabase.readMs < 100 ? <ArrowDown className="w-3 h-3 text-green-500" />
                          : metrics.supabase.readMs < 300 ? <Minus className="w-3 h-3 text-yellow-500" />
                          : <ArrowUp className="w-3 h-3 text-red-500" />}
                        <span className="text-[10px] text-muted-foreground">
                          {metrics.supabase.readMs < 50 ? 'Sangat Cepat'
                            : metrics.supabase.readMs < 100 ? 'Cepat'
                            : metrics.supabase.readMs < 300 ? 'Normal'
                            : metrics.supabase.readMs < 700 ? 'Lambat'
                            : 'Sangat Lambat'}
                        </span>
                      </div>
                    </div>

                    {/* Write Latency */}
                    <div className="space-y-1 p-2.5 bg-background/50 rounded-lg">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Write/RPC</span>
                        <span className={`text-sm font-bold ${getLatencyColor(metrics.supabase.writeMs)}`}>
                          {metrics.supabase.writeMs} ms
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {metrics.supabase.writeMs < 100 ? <ArrowDown className="w-3 h-3 text-green-500" />
                          : metrics.supabase.writeMs < 300 ? <Minus className="w-3 h-3 text-yellow-500" />
                          : <ArrowUp className="w-3 h-3 text-red-500" />}
                        <span className="text-[10px] text-muted-foreground">
                          {metrics.supabase.writeMs < 50 ? 'Sangat Cepat'
                            : metrics.supabase.writeMs < 100 ? 'Cepat'
                            : metrics.supabase.writeMs < 300 ? 'Normal'
                            : metrics.supabase.writeMs < 700 ? 'Lambat'
                            : 'Sangat Lambat'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Latency Sparkline */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Riwayat 60 detik terakhir</span>
                  <div className="opacity-80">
                    <MiniSparkline
                      data={latencyHistory}
                      color={metrics.supabase.readMs < 100 ? '#22c55e' : metrics.supabase.readMs < 300 ? '#eab308' : '#ef4444'}
                    />
                  </div>
                </div>
              </div>

              {/* Uptime & Process Info */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Uptime</span>
                  </div>
                  <span className="text-sm text-muted-foreground">{formatUptime(metrics.uptime)}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Heap</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(metrics.process.memoryUsage.heapUsed)} / {formatBytes(metrics.process.memoryUsage.heapTotal)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <p className="text-sm text-muted-foreground">Mengaktifkan monitoring...</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== DISK (from /api/system/info) ===== */}
      {sys?.disk && sys.disk.total > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <HardDrive className="w-4 h-4" />
              Disk
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Penggunaan Disk</span>
                <span className={`text-sm font-bold ${getUsageColor(sys.disk.usagePercent)}`}>{sys.disk.usagePercent}%</span>
              </div>
              <Progress value={sys.disk.usagePercent} className={`h-2.5 ${getUsageProgressColor(sys.disk.usagePercent)}`} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Terpakai: {formatBytes(sys.disk.used)}</span>
                <span>Total: {formatBytes(sys.disk.total)}</span>
                <span>Bebas: {formatBytes(sys.disk.available)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ===== SUPABASE STORAGE ===== */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="w-4 h-4" />
                Penyimpanan Supabase
              </CardTitle>
              <CardDescription>Jumlah baris per tabel di database</CardDescription>
            </div>
            {supa && (
              <Badge variant="outline">{formatNumber(supa.totalRows)} total baris</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : supa?.tables ? (
            <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
              {supa.tables
                .sort((a, b) => b.rows - a.rows)
                .map((table) => (
                <div key={table.name} className="flex items-center justify-between p-2.5 border rounded-lg hover:bg-muted/30 transition-colors gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${
                      table.rows > 1000 ? 'bg-yellow-500' : 'bg-green-500'
                    }`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{table.label}</p>
                      <p className="text-[10px] text-muted-foreground font-mono">{table.name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-semibold">{formatNumber(table.rows)}</span>
                    <span className="text-xs text-muted-foreground">baris</span>
                    {table.safeToDelete && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Aman Dihapus</Badge>
                    )}
                    {table.canCleanOld && !table.safeToDelete && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">Bersih Lama</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">Gagal memuat data database</p>
          )}
        </CardContent>
      </Card>

      {/* ===== CLEANUP ===== */}
      <Card className="border-orange-200 dark:border-orange-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-orange-600 dark:text-orange-400">
            <Trash2 className="w-4 h-4" />
            Pembersihan Data
          </CardTitle>
          <CardDescription>
            Hapus data yang tidak diperlukan untuk menghemat penyimpanan Supabase
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode Selection */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Mode Pembersihan:</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={() => { setCleanupMode('old'); setSelectedTable(''); }}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left',
                  cleanupMode === 'old'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-muted hover:border-muted-foreground/30'
                )}
              >
                <Clock className="w-5 h-5 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Hapus Data Lama</p>
                  <p className="text-xs text-muted-foreground">Hapus data lebih tua dari N hari</p>
                </div>
              </button>
              <button
                onClick={() => { setCleanupMode('all'); setSelectedTable(''); }}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left',
                  cleanupMode === 'all'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-muted hover:border-muted-foreground/30'
                )}
              >
                <Trash2 className="w-5 h-5 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Hapus Semua Data</p>
                  <p className="text-xs text-muted-foreground">Hanya tabel yang aman (Events, Logs, dll)</p>
                </div>
              </button>
            </div>
          </div>

          {/* Table Selection */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Pilih Tabel:</p>
            <Select value={selectedTable} onValueChange={setSelectedTable}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pilih tabel..." />
              </SelectTrigger>
              <SelectContent>
                {(cleanupMode === 'all' ? safeToDeleteTables : canCleanOldTables).map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.label} ({formatNumber(t.rows)} baris)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Age Threshold (for 'old' mode) */}
          {cleanupMode === 'old' && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Hapus data lebih lama dari:</p>
              <Select value={selectedDays} onValueChange={setSelectedDays}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 hari</SelectItem>
                  <SelectItem value="30">30 hari</SelectItem>
                  <SelectItem value="60">60 hari</SelectItem>
                  <SelectItem value="90">90 hari</SelectItem>
                  <SelectItem value="180">180 hari (6 bulan)</SelectItem>
                  <SelectItem value="365">365 hari (1 tahun)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Warning for 'all' mode */}
          {cleanupMode === 'all' && selectedTable && (
            <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-800 dark:text-red-200">
                    Semua data di tabel &quot;{selectedTableInfo?.label}&quot; akan dihapus
                  </p>
                  <p className="text-xs text-red-700 dark:text-red-300 mt-0.5">
                    {formatNumber(selectedTableInfo?.rows || 0)} baris akan dihapus secara permanen. Tindakan ini tidak dapat dibatalkan.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Info for 'old' mode */}
          {cleanupMode === 'old' && selectedTable && (
            <div className="p-3 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                    Data lebih lama dari {selectedDays} hari akan dihapus dari &quot;{selectedTableInfo?.label}&quot;
                  </p>
                  <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-0.5">
                    Total {formatNumber(selectedTableInfo?.rows || 0)} baris di tabel. Data yang lebih baru dari {selectedDays} hari terakhir akan tetap ada.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Action Button */}
          <Button
            variant="destructive"
            onClick={() => setShowConfirmDialog(true)}
            disabled={!selectedTable || cleanupLoading}
            className="w-full sm:w-auto"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            {cleanupMode === 'all' ? 'Hapus Semua Data' : `Hapus Data Lama (${selectedDays} hari)`}
          </Button>
        </CardContent>
      </Card>

      {/* ===== CONFIRMATION DIALOG ===== */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Konfirmasi Hapus Data
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <p>
                Anda akan menghapus <strong>secara permanen</strong> {cleanupMode === 'all' ? 'semua data' : `data lebih lama dari ${selectedDays} hari`} dari tabel:
              </p>
              <Badge variant="destructive" className="text-xs">{selectedTableInfo?.label || selectedTable}</Badge>
              {cleanupMode === 'all' && (
                <p className="text-destructive font-medium">{formatNumber(selectedTableInfo?.rows || 0)} baris akan dihapus</p>
              )}
              <p className="text-xs text-muted-foreground">Tindakan ini tidak dapat dibatalkan.</p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setShowConfirmDialog(false)}>Batal</Button>
            <Button variant="destructive" className="w-full sm:w-auto" onClick={handleCleanup} disabled={cleanupLoading}>
              {cleanupLoading ? (
                <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Menghapus...</>
              ) : (
                <><Trash2 className="w-4 h-4 mr-2" />Ya, Hapus Data</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function cn(...inputs: (string | undefined | false)[]) {
  return inputs.filter(Boolean).join(' ');
}
