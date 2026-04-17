'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  Server,
  HardDrive,
  FolderOpen,
  Database,
  Trash2,
  ClipboardList,
  Bell,
  Check,
  AlertTriangle,
  Download,
  RefreshCw,
  Shield,
  X,
  Cloud,
  BarChart3,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Search,
  Eye,
  Square,
  CheckSquare,
  Loader2,
  Table2,
  Filter,
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
  Cpu,
  MemoryStick,
  Power,
  Wrench,
  Activity,
  Wifi,
  WifiOff,
  Clock,
  Zap,
  Thermometer,
  ArrowUpRight,
  Circle,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingFallback } from '@/components/error-boundary';

// Table definitions for data browser
const DATA_TABLES = [
  { id: 'logs', label: 'Activity Log', icon: <ClipboardList className="w-4 h-4 text-amber-500" />, deletable: true },
  { id: 'events', label: 'Notifikasi', icon: <Bell className="w-4 h-4 text-blue-500" />, deletable: true },
  { id: 'finance_requests', label: 'Request Keuangan', icon: <Database className="w-4 h-4 text-purple-500" />, deletable: true },
  { id: 'salary_payments', label: 'Pembayaran Gaji', icon: <Database className="w-4 h-4 text-green-500" />, deletable: true },
  { id: 'receivables', label: 'Piutang', icon: <Database className="w-4 h-4 text-orange-500" />, deletable: true },
  { id: 'company_debts', label: 'Hutang Perusahaan', icon: <Database className="w-4 h-4 text-red-500" />, deletable: true },
  { id: 'fund_transfers', label: 'Transfer Dana', icon: <Database className="w-4 h-4 text-cyan-500" />, deletable: true },
  { id: 'transactions', label: 'Transaksi', icon: <Database className="w-4 h-4 text-emerald-500" />, deletable: false },
  { id: 'payments', label: 'Pembayaran', icon: <Database className="w-4 h-4 text-teal-500" />, deletable: false },
  { id: 'courier_cash', label: 'Kas Kurir', icon: <Database className="w-4 h-4 text-amber-600" />, deletable: false },
];

// ---- System Stats types ----
interface SystemStats {
  cpu: { percent: number; cores: number; loadAvg: number[] };
  memory: { total: number; used: number; available: number; percent: number; swapTotal: number; swapUsed: number };
  nodeMemory: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  uptime: number;
  process: { pid: number; ppid: number; threads: number };
  activeConnections: number;
  timestamp: string;
}

interface SupabaseHealthCheck {
  name: string;
  status: 'connected' | 'degraded' | 'disconnected';
  latencyMs: number;
  detail: string;
}

interface SupabaseHealth {
  overall: 'connected' | 'degraded' | 'disconnected';
  avgLatencyMs: number;
  checks: SupabaseHealthCheck[];
  timestamp: string;
}

interface RepairResult {
  check: string;
  status: 'passed' | 'fixed' | 'failed' | 'skipped';
  message: string;
  details?: any;
}

// ---- Helper functions ----
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatKB(kb: number): string {
  return formatBytes(kb * 1024);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}h ${hours}j ${mins}m`;
  if (hours > 0) return `${hours}j ${mins}m ${secs}d`;
  return `${mins}m ${secs}d`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(amount || 0);
}

// ---- Circular Progress Component ----
function CircularGauge({ value, max, size = 80, strokeWidth = 6, colorClass }: {
  value: number; max: number; size?: number; strokeWidth?: number; colorClass: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const percent = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90" width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" className="text-muted/30" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          className={colorClass}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-sm font-bold">{Math.round(percent)}%</span>
      </div>
    </div>
  );
}

// ================================================================
// MAIN COMPONENT
// ================================================================
export default function StorageTab({ queryClient }: { queryClient: QueryClient }) {
  const { user } = useAuthStore();

  // ---- Real-time System Stats ----
  const [liveStats, setLiveStats] = useState<SystemStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const json = await apiFetch<{ success: boolean; data: SystemStats; error?: string }>('/api/system/stats');
      if (json.success && json.data) {
        setLiveStats(json.data);
        setStatsError(false);
      } else {
        setStatsError(true);
      }
    } catch {
      setStatsError(true);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    statsIntervalRef.current = setInterval(fetchStats, 3000); // every 3s
    return () => { if (statsIntervalRef.current) clearInterval(statsIntervalRef.current); };
  }, [fetchStats]);

  // ---- Real-time Supabase Health ----
  const [supabaseHealth, setSupabaseHealth] = useState<SupabaseHealth | null>(null);
  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const json = await apiFetch<{ success: boolean; data: SupabaseHealth; error?: string }>('/api/system/supabase-health');
      if (json.success && json.data) {
        setSupabaseHealth(json.data);
      }
    } catch { /* health check fails silently */ }
  }, []);

  useEffect(() => {
    fetchHealth();
    healthIntervalRef.current = setInterval(fetchHealth, 5000); // every 5s
    return () => { if (healthIntervalRef.current) clearInterval(healthIntervalRef.current); };
  }, [fetchHealth]);

  // ---- Existing Storage Info ----
  const { data: storageData, isLoading: storageLoading, isError: storageError, refetch: refetchStorage } = useQuery({
    queryKey: ['storage-info'],
    queryFn: async () => {
      const json = await apiFetch<{ success: boolean; data: any; error?: string }>('/api/storage');
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    refetchInterval: 30000,
    retry: 1,
    staleTime: 30_000,
  });

  // Supabase quota query
  const { data: quotaData, isLoading: quotaLoading, isError: quotaError, error: quotaErrorData, refetch: refetchQuota } = useQuery({
    queryKey: ['storage-supabase-quota'],
    queryFn: async () => {
      const json = await apiFetch<{ success: boolean; data: any; error?: string }>('/api/storage/supabase-quota');
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    refetchInterval: 60000,
    retry: 1,
    staleTime: 60_000,
  });

  const [selectedCleanup, setSelectedCleanup] = useState<string[]>([]);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);

  // Data Browser state
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [tableStatus, setTableStatus] = useState<string>('all');
  const [tableSearch, setTableSearch] = useState('');
  const [tablePage, setTablePage] = useState(1);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // ---- Restart Server ----
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const restartMutation = useMutation({
    mutationFn: () => apiFetch('/api/system/restart', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Server sedang di-restart... Tunggu beberapa detik lalu refresh halaman.');
      setShowRestartConfirm(false);
      // Auto-refresh after 5 seconds
      setTimeout(() => window.location.reload(), 5000);
    },
    onError: () => toast.error('Gagal restart server'),
  });

  // ---- Auto Repair ----
  const [showRepairResult, setShowRepairResult] = useState(false);
  const [repairResult, setRepairResult] = useState<{ results: RepairResult[]; summary: { total: number; passed: number; fixed: number; failed: number }; message: string } | null>(null);
  const repairMutation = useMutation({
    mutationFn: () => apiFetch<{ success: boolean; results?: RepairResult[]; summary?: any; message?: string }>('/api/system/auto-repair', { method: 'POST' }),
    onSuccess: (data) => {
      if (data.success) {
        setRepairResult({ results: data.results || [], summary: data.summary || { total: 0, passed: 0, fixed: 0, failed: 0 }, message: data.message || '' });
        setShowRepairResult(true);
        queryClient.invalidateQueries({ queryKey: ['storage-info'] });
        refetchStorage();
        fetchStats();
        fetchHealth();
        toast.success(data.message || 'Auto-repair selesai!');
      }
    },
    onError: () => toast.error('Gagal menjalankan auto-repair'),
  });

  // Fetch table data for browser
  const { data: tableData, isLoading: tableLoading, refetch: refetchTable } = useQuery({
    queryKey: ['table-data', activeTable, tableStatus, tablePage, tableSearch],
    queryFn: async () => {
      if (!activeTable) return null;
      const params = new URLSearchParams({ table: activeTable, page: String(tablePage), limit: '20' });
      if (tableStatus !== 'all') params.set('status', tableStatus);
      if (tableSearch) params.set('search', tableSearch);
      const json = await apiFetch<any>(`/api/storage/table-data?${params}`);
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    enabled: !!activeTable,
  });

  const cleanupMutation = useMutation({
    mutationFn: async (targets: string[]) => apiFetch<{ results: any }>('/api/storage', { method: 'POST', body: JSON.stringify({ action: 'cleanup', targets }) }),
    onSuccess: (data) => {
      toast.success(`Cleanup berhasil! ${JSON.stringify(data.results)}`);
      setSelectedCleanup([]);
      setShowCleanupConfirm(false);
      queryClient.invalidateQueries({ queryKey: ['storage-info'] });
      queryClient.invalidateQueries({ queryKey: ['storage-supabase-quota'] });
      refetchStorage();
      refetchQuota();
    },
    onError: () => toast.error('Gagal melakukan cleanup'),
  });

  const deleteRecordsMutation = useMutation({
    mutationFn: async ({ table, ids }: { table: string; ids: string[] }) => apiFetch('/api/storage/table-data', { method: 'DELETE', body: JSON.stringify({ table, ids }) }),
    onSuccess: (data: any) => { toast.success(data.message || 'Data berhasil dihapus'); setSelectedRows([]); setShowDeleteConfirm(false); refetchTable(); refetchStorage(); },
    onError: (err: any) => toast.error('Gagal menghapus: ' + (err.message || 'Unknown error')),
  });

  const deleteFilterMutation = useMutation({
    mutationFn: async ({ table, filter }: { table: string; filter: any }) => apiFetch('/api/storage/table-data', { method: 'DELETE', body: JSON.stringify({ table, filter }) }),
    onSuccess: (data: any) => { toast.success(data.message || 'Data berhasil dihapus'); setTablePage(1); refetchTable(); refetchStorage(); },
    onError: (err: any) => toast.error('Gagal menghapus: ' + (err.message || 'Unknown error')),
  });

  const handleBackup = async () => {
    setBackupLoading(true);
    try {
      const json = await apiFetch<any>('/api/storage', { method: 'POST', body: JSON.stringify({ action: 'backup' }) });
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `razkindo_backup_${format(new Date(), 'yyyy-MM-dd_HHmmss')}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Backup berhasil diunduh!');
    } catch { toast.error('Gagal membuat backup'); } finally { setBackupLoading(false); }
  };

  const toggleCleanup = (target: string) => setSelectedCleanup(prev => prev.includes(target) ? prev.filter(t => t !== target) : [...prev, target]);

  const handleOpenTable = (tableId: string) => { setActiveTable(tableId); setTableStatus('all'); setTableSearch(''); setTablePage(1); setSelectedRows([]); };
  const handleToggleRow = (id: string) => setSelectedRows(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]);
  const handleSelectAll = () => { if (!tableData?.records) return; setSelectedRows(prev => prev.length === tableData.records.length ? [] : tableData.records.map((r: any) => r.id)); };
  const handleDeleteAllFiltered = () => { if (!activeTable) return; const filter: any = {}; if (tableStatus !== 'all') filter.status = tableStatus; if (tableSearch) filter.search = tableSearch; deleteFilterMutation.mutate({ table: activeTable, filter }); };

  const disk = storageData?.disk;
  const project = storageData?.project;
  const database = storageData?.database;
  const cleanable = storageData?.cleanable;
  const tableCounts = storageData?.database?.tableCounts;
  const quota = quotaData;
  const dbQuota = quota?.database;
  const storageQuota = quota?.storage;
  const topTables = quota?.topTables;
  const rowCounts = quota?.rowCounts;
  const indexes = quota?.indexes;
  const serverInfo = quota?.serverInfo;
  const isEstimate = quota?.source === 'estimate';

  const CLEANUP_OPTIONS = [
    // Server temp files (safe to delete, auto-recreated)
    { id: 'tmp_tectonic', label: 'Cache LaTeX (/tmp/tectonic)', description: 'Cache compiler LaTeX — aman dihapus, akan dibuat ulang otomatis', count: cleanable?.tmp_tectonic || 0, icon: <FolderOpen className="w-4 h-4 text-purple-500" />, safe: true },
    { id: 'tmp_head_tar', label: 'Git Archive (/tmp/HEAD.tar)', description: 'File archive sementara — aman dihapus', count: cleanable?.tmp_head_tar || 0, icon: <FolderOpen className="w-4 h-4 text-gray-500" />, safe: true },
    { id: 'tmp_razkindo_archive', label: 'Archive Lama (/tmp/razkindo-archive)', description: 'Archive project sementara — aman dihapus', count: cleanable?.tmp_razkindo_archive || 0, icon: <FolderOpen className="w-4 h-4 text-gray-500" />, safe: true },
    { id: 'tmp_my_project', label: 'Project Temp (/tmp/my-project)', description: 'Project sementara lama — aman dihapus', count: cleanable?.tmp_my_project || 0, icon: <FolderOpen className="w-4 h-4 text-gray-500" />, safe: true },
    { id: 'next_cache', label: 'Cache Next.js (.next/cache)', description: 'Cache build Next.js — aman dihapus, akan dibuat ulang', count: cleanable?.next_cache || 0, icon: <FolderOpen className="w-4 h-4 text-blue-500" />, safe: true },
    { id: 'node_modules_cache', label: 'Cache Node (node_modules/.cache)', description: 'Cache dependensi Node — aman dihapus', count: cleanable?.node_modules_cache || 0, icon: <FolderOpen className="w-4 h-4 text-blue-400" />, safe: true },
    // Database cleanup options
    { id: 'old_logs_30d', label: 'Log Lama (>30 hari)', description: 'Hapus activity log yang lebih dari 30 hari', count: cleanable?.old_logs_30d || 0, icon: <ClipboardList className="w-4 h-4 text-amber-500" />, safe: true },
    { id: 'old_read_events_7d', label: 'Notifikasi Lama (>7 hari)', description: 'Hapus notifikasi yang sudah dibaca & >7 hari', count: cleanable?.old_read_events_7d || 0, icon: <Bell className="w-4 h-4 text-blue-500" />, safe: true },
    { id: 'rejected_finance_requests', label: 'Request Ditolak', description: 'Hapus permintaan finance yang ditolak', count: cleanable?.rejected_finance_requests || 0, icon: <X className="w-4 h-4 text-red-500" />, safe: true },
    { id: 'rejected_salary_payments', label: 'Gaji Ditolak', description: 'Hapus pembayaran gaji yang ditolak', count: cleanable?.rejected_salary_payments || 0, icon: <X className="w-4 h-4 text-red-400" />, safe: true },
    { id: 'cancelled_receivables', label: 'Piutang Dibatalkan', description: 'Hapus piutang dengan status dibatalkan', count: cleanable?.cancelled_receivables || 0, icon: <X className="w-4 h-4 text-orange-500" />, safe: true },
    { id: 'bad_debt_receivables', label: 'Piutang Macet', description: 'Hapus piutang yang sudah ditandai macet', count: cleanable?.bad_debt_receivables || 0, icon: <AlertTriangle className="w-4 h-4 text-red-600" />, safe: true },
    { id: 'all_read_events', label: 'Semua Notifikasi Terbaca', description: 'Hapus SEMUA notifikasi yang sudah dibaca', count: cleanable?.total_read_events || 0, icon: <Bell className="w-4 h-4 text-yellow-500" />, safe: false },
    { id: 'all_logs', label: 'Semua Log', description: 'Hapus SEMUA log aktivitas', count: cleanable?.total_logs || 0, icon: <ClipboardList className="w-4 h-4 text-red-600" />, safe: false },
  ];

  // Helper: format record for display
  const getRecordLabel = (record: any, table: string) => {
    switch (table) {
      case 'logs': return record.action || record.message || '-';
      case 'events': return record.title || record.message || '-';
      case 'finance_requests': return `${record.description || '-'} (${formatCurrency(record.amount)})`;
      case 'salary_payments': return `${record.month || '-'} ${record.year || ''}`;
      case 'receivables': return `${record.customer_name || record.description || '-'}`;
      case 'company_debts': return record.description || record.supplier_name || '-';
      case 'fund_transfers': return record.description || '-';
      case 'transactions': return record.transaction_no || '-';
      case 'payments': return `${record.method || '-'} ${formatCurrency(record.amount)}`;
      case 'courier_cash': return record.description || '-';
      default: return record.id?.slice(0, 8) || '-';
    }
  };

  const getRecordStatus = (record: any, table: string) => {
    switch (table) {
      case 'finance_requests': case 'salary_payments': case 'receivables': case 'company_debts': case 'fund_transfers': case 'transactions':
        return record.status || '-';
    }
    return null;
  };

  const getStatusBadge = (status: string, _table: string) => {
    const variants: Record<string, { label: string; color: string }> = {
      pending: { label: 'Menunggu', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' },
      approved: { label: 'Disetujui', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' },
      processed: { label: 'Selesai', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
      completed: { label: 'Selesai', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
      paid: { label: 'Dibayar', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300' },
      rejected: { label: 'Ditolak', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
      cancelled: { label: 'Dibatalkan', color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
      active: { label: 'Aktif', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' },
      bad_debt: { label: 'Macet', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
    };
    const v = variants[status];
    if (!v) return <Badge variant="outline" className="text-xs">{status}</Badge>;
    return <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium", v.color)}>{v.label}</span>;
  };

  if (storageLoading) return <LoadingFallback message="Memuat info storage..." />;

  if (storageError && !storageData) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <AlertTriangle className="w-8 h-8 text-amber-500" />
        <p className="text-sm text-muted-foreground">Gagal memuat info storage</p>
        <Button variant="outline" size="sm" onClick={() => refetchStorage()}>
          <RefreshCw className="w-3 h-3 mr-1" /> Coba Lagi
        </Button>
      </div>
    );
  }

  // CPU/Memory color helpers
  const cpuPercent = liveStats?.cpu.percent ?? 0;
  const memPercent = liveStats?.memory.percent ?? 0;
  const cpuColor = cpuPercent > 80 ? 'text-red-500' : cpuPercent > 60 ? 'text-amber-500' : 'text-emerald-500';
  const memColor = memPercent > 80 ? 'text-red-500' : memPercent > 60 ? 'text-amber-500' : 'text-emerald-500';
  const cpuStrokeColor = cpuPercent > 80 ? 'text-red-500' : cpuPercent > 60 ? 'text-amber-500' : 'text-emerald-500';
  const memStrokeColor = memPercent > 80 ? 'text-red-500' : memPercent > 60 ? 'text-amber-500' : 'text-emerald-500';

  // Supabase health status
  const sbOverall = supabaseHealth?.overall ?? null;
  const sbStatusColor = sbOverall === 'connected' ? 'text-emerald-500' : sbOverall === 'degraded' ? 'text-amber-500' : 'text-red-500';
  const sbStatusBg = sbOverall === 'connected' ? 'bg-emerald-500' : sbOverall === 'degraded' ? 'bg-amber-500' : 'bg-red-500';
  const sbStatusLabel = sbOverall === 'connected' ? 'Terhubung' : sbOverall === 'degraded' ? 'Lambat' : 'Terputus';

  return (
    <div className="space-y-4">
      {/* ======================================================= */}
      {/* REAL-TIME SYSTEM MONITOR: CPU, RAM, SUPABASE CONNECTION */}
      {/* ======================================================= */}
      <Card className="border-primary/30 overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                Monitor Sistem Real-Time
              </CardTitle>
              <CardDescription>CPU, RAM, dan koneksi database — diperbarui otomatis setiap 3 detik</CardDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <Circle className={cn("w-2 h-2 fill-current animate-pulse", liveStats ? "text-emerald-500" : "text-muted-foreground")} />
              <span className="text-xs text-muted-foreground">{liveStats ? 'Live' : 'Connecting...'}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Gauges Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* CPU Gauge */}
            <div className="flex flex-col items-center gap-2 p-3 rounded-xl bg-muted/30 border">
              <CircularGauge value={cpuPercent} max={100} size={90} strokeWidth={7} colorClass={cpuStrokeColor} />
              <div className="text-center">
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <Cpu className="w-3 h-3" /> CPU Load
                </p>
                <p className={cn("text-lg font-bold", cpuColor)}>{cpuPercent}%</p>
                {liveStats && (
                  <p className="text-[10px] text-muted-foreground">{liveStats.cpu.cores} cores · Load: {liveStats.cpu.loadAvg[0]?.toFixed(2)}</p>
                )}
              </div>
            </div>

            {/* RAM Gauge */}
            <div className="flex flex-col items-center gap-2 p-3 rounded-xl bg-muted/30 border">
              <CircularGauge value={memPercent} max={100} size={90} strokeWidth={7} colorClass={memStrokeColor} />
              <div className="text-center">
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <MemoryStick className="w-3 h-3" /> RAM
                </p>
                <p className={cn("text-lg font-bold", memColor)}>{memPercent}%</p>
                {liveStats && (
                  <p className="text-[10px] text-muted-foreground">{formatKB(liveStats.memory.used)} / {formatKB(liveStats.memory.total)}</p>
                )}
              </div>
            </div>

            {/* Supabase Connection */}
            <div className="flex flex-col items-center gap-2 p-3 rounded-xl bg-muted/30 border">
              <div className="relative" style={{ width: 90, height: 90 }}>
                <svg className="transform -rotate-90" width={90} height={90}>
                  <circle cx={45} cy={45} r={38} fill="none" stroke="currentColor" className="text-muted/30" strokeWidth={7} />
                  <circle
                    cx={45} cy={45} r={38} fill="none"
                    className={sbStatusColor}
                    stroke="currentColor"
                    strokeWidth={7}
                    strokeDasharray={38 * 2 * Math.PI}
                    strokeDashoffset={sbOverall === 'connected' ? 0 : sbOverall === 'degraded' ? 38 * Math.PI * 0.3 : 38 * Math.PI * 0.7}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  {sbOverall === 'connected' ? (
                    <Wifi className={cn("w-5 h-5", sbStatusColor)} />
                  ) : sbOverall === 'degraded' ? (
                    <Activity className={cn("w-5 h-5", sbStatusColor)} />
                  ) : (
                    <WifiOff className={cn("w-5 h-5", sbStatusColor)} />
                  )}
                </div>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <Database className="w-3 h-3" /> Supabase
                </p>
                <p className={cn("text-lg font-bold", sbStatusColor)}>{sbStatusLabel}</p>
                <p className="text-[10px] text-muted-foreground">{supabaseHealth?.avgLatencyMs ?? '-'}ms avg</p>
              </div>
            </div>

            {/* Uptime & Process */}
            <div className="flex flex-col items-center gap-2 p-3 rounded-xl bg-muted/30 border">
              <div className="w-[90px] h-[90px] flex items-center justify-center">
                <div className="text-center">
                  <Clock className="w-6 h-6 text-primary mx-auto mb-1" />
                  <p className="text-lg font-bold text-primary">{formatUptime(liveStats?.uptime ?? 0)}</p>
                </div>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Uptime</p>
                {liveStats && (
                  <p className="text-[10px] text-muted-foreground">
                    PID: {liveStats.process.pid} · {liveStats.process.threads} threads · {liveStats.activeConnections} conn
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Detail Bars */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* CPU Detail */}
            <div className="space-y-2 p-3 rounded-lg bg-muted/30 border">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">CPU Usage</span>
                <span className={cn("font-bold", cpuColor)}>{cpuPercent}%</span>
              </div>
              <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full transition-all duration-500", cpuPercent > 80 ? "bg-red-500" : cpuPercent > 60 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${cpuPercent}%` }} />
              </div>
              {liveStats && (
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Load 1m: {liveStats.cpu.loadAvg[0]?.toFixed(2)}</span>
                  <span>5m: {liveStats.cpu.loadAvg[1]?.toFixed(2)}</span>
                  <span>15m: {liveStats.cpu.loadAvg[2]?.toFixed(2)}</span>
                </div>
              )}
            </div>

            {/* RAM Detail */}
            <div className="space-y-2 p-3 rounded-lg bg-muted/30 border">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">RAM Usage</span>
                <span className={cn("font-bold", memColor)}>{memPercent}%</span>
              </div>
              <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full transition-all duration-500", memPercent > 80 ? "bg-red-500" : memPercent > 60 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${memPercent}%` }} />
              </div>
              {liveStats && (
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Used: {formatKB(liveStats.memory.used)}</span>
                  <span>Avail: {formatKB(liveStats.memory.available)}</span>
                  <span>Total: {formatKB(liveStats.memory.total)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Node.js Process Memory & Swap */}
          {liveStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="p-2 rounded-lg bg-muted/50 border text-center">
                <p className="text-[10px] text-muted-foreground">Node RSS</p>
                <p className="font-bold text-sm">{formatKB(liveStats.nodeMemory.rss)}</p>
              </div>
              <div className="p-2 rounded-lg bg-muted/50 border text-center">
                <p className="text-[10px] text-muted-foreground">Heap Used</p>
                <p className="font-bold text-sm">{formatKB(liveStats.nodeMemory.heapUsed)}</p>
              </div>
              <div className="p-2 rounded-lg bg-muted/50 border text-center">
                <p className="text-[10px] text-muted-foreground">Heap Total</p>
                <p className="font-bold text-sm">{formatKB(liveStats.nodeMemory.heapTotal)}</p>
              </div>
              <div className="p-2 rounded-lg bg-muted/50 border text-center">
                <p className="text-[10px] text-muted-foreground">Swap</p>
                <p className={cn("font-bold text-sm", liveStats.memory.swapUsed > 0 ? "text-amber-500" : "")}>
                  {liveStats.memory.swapUsed > 0 ? formatKB(liveStats.memory.swapUsed) : '0'}
                </p>
              </div>
            </div>
          )}

          {/* Supabase Health Details */}
          {supabaseHealth && (
            <div className="space-y-2 p-3 rounded-lg border bg-muted/20">
              <div className="text-xs font-medium flex items-center gap-1.5">
                <span className={cn("w-2 h-2 rounded-full inline-block", sbStatusBg)} />
                Supabase Health Check — {sbStatusLabel}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {supabaseHealth.checks.map((check) => (
                  <div key={check.name} className="p-2 rounded-lg bg-background border text-center">
                    <p className="text-[10px] text-muted-foreground">{check.name}</p>
                    <p className={cn(
                      "font-bold text-xs",
                      check.status === 'connected' ? 'text-emerald-500' : check.status === 'degraded' ? 'text-amber-500' : 'text-red-500'
                    )}>
                      {check.status === 'connected' ? '✓' : check.status === 'degraded' ? '⚠' : '✗'} {check.latencyMs}ms
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ======================================================= */}
      {/* ACTION BUTTONS: Restart, Auto-Repair, Clean Storage     */}
      {/* ======================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Restart Server */}
        <Card className="border-red-200 dark:border-red-900/50 hover:border-red-400 transition-colors cursor-pointer group" onClick={() => setShowRestartConfirm(true)}>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Power className="w-6 h-6 text-red-500" />
            </div>
            <div>
              <p className="font-semibold text-sm">Restart Server</p>
              <p className="text-xs text-muted-foreground">Mulai ulang server Next.js</p>
            </div>
          </CardContent>
        </Card>

        {/* Auto Repair */}
        <Card className="border-amber-200 dark:border-amber-900/50 hover:border-amber-400 transition-colors cursor-pointer group" onClick={() => repairMutation.mutate()}>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Wrench className="w-6 h-6 text-amber-500" />
            </div>
            <div>
              <p className="font-semibold text-sm">Auto Repair Bugs</p>
              <p className="text-xs text-muted-foreground">Perbaiki & bersihkan otomatis</p>
            </div>
            {repairMutation.isPending && <Loader2 className="w-4 h-4 animate-spin text-amber-500 ml-auto" />}
          </CardContent>
        </Card>

        {/* Quick Clean Storage */}
        <Card className="border-emerald-200 dark:border-emerald-900/50 hover:border-emerald-400 transition-colors cursor-pointer group" onClick={() => {
          // Auto-select safe cleanup options
          const safeOpts = CLEANUP_OPTIONS.filter(o => o.safe && o.count > 0).map(o => o.id);
          if (safeOpts.length > 0) {
            setSelectedCleanup(safeOpts);
            setShowCleanupConfirm(true);
          } else {
            toast.info('Tidak ada data yang perlu dibersihkan');
          }
        }}>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Trash2 className="w-6 h-6 text-emerald-500" />
            </div>
            <div>
              <p className="font-semibold text-sm">Bersihkan Storage</p>
              <p className="text-xs text-muted-foreground">Hapus data tidak diperlukan</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Restart Confirmation Dialog */}
      <Dialog open={showRestartConfirm} onOpenChange={setShowRestartConfirm}>
        <DialogContent className="sm:max-w-md w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Power className="w-5 h-5" /> Restart Server?
            </DialogTitle>
            <DialogDescription>
              Server akan dimulai ulang. Semua pengguna yang sedang aktif akan terputus sementara.
              Halaman akan otomatis refresh setelah server kembali online.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setShowRestartConfirm(false)}>Batal</Button>
            <Button variant="destructive" className="w-full sm:w-auto" onClick={() => restartMutation.mutate()} disabled={restartMutation.isPending}>
              {restartMutation.isPending ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Merestart...</> : <><Power className="w-4 h-4 mr-1" /> Ya, Restart</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Auto Repair Result Dialog */}
      <Dialog open={showRepairResult} onOpenChange={setShowRepairResult}>
        <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[80dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="w-5 h-5 text-amber-500" /> Hasil Auto Repair
            </DialogTitle>
            <DialogDescription>
              {repairResult && `${repairResult.summary.passed} OK · ${repairResult.summary.fixed} diperbaiki · ${repairResult.summary.failed} gagal`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {repairResult?.results.map((action, i) => (
              <div key={i} className={cn(
                "flex items-start gap-2 p-2.5 rounded-lg border text-sm",
                action.status === 'passed' ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800' :
                action.status === 'fixed' ? 'bg-blue-50 border-blue-200 dark:bg-blue-950/20 dark:border-blue-800' :
                action.status === 'failed' ? 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800' :
                'bg-muted/50'
              )}>
                {action.status === 'passed' ? <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" /> :
                 action.status === 'fixed' ? <Wrench className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" /> :
                 action.status === 'failed' ? <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" /> :
                 <div className="w-4 h-4 mt-0.5 shrink-0" />}
                <div>
                  <p className="font-medium text-xs">{action.check}</p>
                  <p className="text-xs text-muted-foreground">{action.message}</p>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => setShowRepairResult(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Cleanup Confirm Dialog */}
      <Dialog open={showCleanupConfirm && selectedCleanup.length > 0} onOpenChange={(open) => { if (!open) { setShowCleanupConfirm(false); } }}>
        <DialogContent className="sm:max-w-md w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Konfirmasi Pembersihan Data</DialogTitle>
            <DialogDescription>
              Anda akan menghapus {selectedCleanup.length} jenis data. Tindakan ini tidak dapat dibatalkan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {selectedCleanup.map(id => {
              const opt = CLEANUP_OPTIONS.find(o => o.id === id);
              return (
                <div key={id} className="flex items-center justify-between text-sm p-2 bg-muted/50 rounded">
                  <span>{opt?.label}</span>
                  <Badge variant="secondary">{id.startsWith('tmp_') || id === 'next_cache' || id === 'node_modules_cache' ? formatBytes(opt?.count || 0) : String(opt?.count || 0)}</Badge>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCleanupConfirm(false); setSelectedCleanup([]); }}>Batal</Button>
            <Button variant="destructive" onClick={() => cleanupMutation.mutate(selectedCleanup)} disabled={cleanupMutation.isPending}>
              {cleanupMutation.isPending ? 'Menghapus...' : 'Ya, Hapus Data'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ======================================================= */}
      {/* SERVER STORAGE OVERVIEW (existing)                       */}
      {/* ======================================================= */}
      <Card className="border-emerald-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="w-4 h-4 text-emerald-500" />
            Storage Server Z.ai
          </CardTitle>
          <CardDescription>Informasi penggunaan storage pada server</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {disk ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Penggunaan Disk</span>
                  <span className={cn("font-bold text-lg", disk.percent > 80 ? "text-red-500" : disk.percent > 60 ? "text-amber-500" : "text-emerald-500")}>
                    {disk.percent}%
                  </span>
                </div>
                <div className="w-full h-4 bg-muted rounded-full overflow-hidden">
                  <div className={cn("h-full rounded-full transition-all duration-500", disk.percent > 80 ? "bg-red-500" : disk.percent > 60 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${Math.min(disk.percent, 100)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Terpakai: {disk.usedFormatted}</span>
                  <span>Tersedia: {disk.availableFormatted}</span>
                  <span>Total: {disk.totalFormatted}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-muted/50 border"><p className="text-xs text-muted-foreground">Total Disk</p><p className="font-bold text-lg">{disk.totalFormatted}</p></div>
                <div className="p-3 rounded-lg bg-muted/50 border"><p className="text-xs text-muted-foreground">Terpakai</p><p className="font-bold text-lg text-amber-500">{disk.usedFormatted}</p></div>
                <div className="p-3 rounded-lg bg-muted/50 border"><p className="text-xs text-muted-foreground">Tersedia</p><p className="font-bold text-lg text-emerald-500">{disk.availableFormatted}</p></div>
                <div className="p-3 rounded-lg bg-muted/50 border"><p className="text-xs text-muted-foreground">Ukuran Proyek</p><p className="font-bold text-lg">{project?.totalFormatted || '0 B'}</p></div>
              </div>
            </>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <HardDrive className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Tidak dapat membaca info disk</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ======================================================= */}
      {/* SUPABASE QUOTA (existing)                                */}
      {/* ======================================================= */}
      <Card className="border-violet-500/30">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-2">
                <Cloud className="w-4 h-4 text-violet-500" />
                Kuota Supabase (Free Tier)
              </CardTitle>
              <CardDescription>Sisa storage & database gratis yang tersedia di Supabase</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => refetchQuota()} disabled={quotaLoading}>
              <RefreshCw className={cn("w-3 h-3", quotaLoading && "animate-spin")} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {quotaLoading && !dbQuota && !quotaError ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <RefreshCw className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">Mengambil kuota Supabase...</span>
            </div>
          ) : dbQuota ? (
            <>
              {/* Database Quota */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-md bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                      <Database className="w-4 h-4 text-violet-600" />
                    </div>
                    <div>
                      <p className="font-medium text-sm flex items-center gap-2">
                        Database
                        {isEstimate && <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-300 text-amber-600">Estimasi</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">PostgreSQL — {dbQuota.plan}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="border-violet-300 text-violet-700 dark:text-violet-400 shrink-0">{dbQuota.planLimitLabel}</Badge>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground text-xs">Penggunaan Database</span>
                    <span className={cn("font-bold text-base", dbQuota.usedPercent > 90 ? "text-red-500" : dbQuota.usedPercent > 70 ? "text-amber-500" : "text-violet-500")}>{dbQuota.usedPercent}%</span>
                  </div>
                  <div className="w-full h-5 bg-muted rounded-full overflow-hidden relative">
                    <div className={cn("h-full rounded-full transition-all duration-700", dbQuota.usedPercent > 90 ? "bg-red-500" : dbQuota.usedPercent > 70 ? "bg-amber-500" : "bg-violet-500")} style={{ width: `${Math.max(Math.min(dbQuota.usedPercent, 100), 2)}%` }} />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Terpakai: <span className="font-semibold text-foreground">{dbQuota.sizePretty}</span></span>
                    <span>Sisa: <span className={cn("font-semibold", dbQuota.usedPercent > 90 ? "text-red-500" : "text-emerald-500")}>{dbQuota.remainingPretty}</span></span>
                    <span>Limit: {dbQuota.freeLimitPretty}</span>
                  </div>
                </div>
                {dbQuota.usedPercent > 70 && (
                  <div className={cn("flex items-start gap-2 p-2.5 rounded-lg text-xs", dbQuota.usedPercent > 90 ? "bg-red-50 border border-red-200 text-red-700" : "bg-amber-50 border border-amber-200 text-amber-700")}>
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium">{dbQuota.usedPercent > 90 ? 'Database hampir penuh!' : 'Database mulai penuh'}</p>
                      <p>{dbQuota.usedPercent > 90 ? 'Segera bersihkan data atau upgrade ke plan berbayar.' : 'Pertimbangkan untuk membersihkan data lama.'}</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t" />

              {/* Storage Quota */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-md bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                      <HardDrive className="w-4 h-4 text-emerald-600" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">File Storage</p>
                      <p className="text-xs text-muted-foreground">Supabase Storage Bucket — {storageQuota?.plan}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:text-emerald-400 shrink-0">{storageQuota?.planLimitLabel}</Badge>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg border">
                  <div className="flex items-center gap-2 text-sm">
                    <ArrowDown className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground text-xs">Batas File Storage: <span className="font-semibold text-foreground">{storageQuota?.freeLimitPretty || '1 GB'}</span></span>
                  </div>
                </div>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-muted/50 border text-center"><p className="text-xs text-muted-foreground">DB Terpakai</p><p className={cn("font-bold text-sm", dbQuota.usedPercent > 90 ? "text-red-500" : "text-violet-500")}>{dbQuota.sizePretty}</p></div>
                <div className="p-3 rounded-lg bg-muted/50 border text-center"><p className="text-xs text-muted-foreground">DB Sisa</p><p className="font-bold text-sm text-emerald-500">{dbQuota.remainingPretty}</p></div>
                <div className="p-3 rounded-lg bg-muted/50 border text-center"><p className="text-xs text-muted-foreground">Total Index</p><p className="font-bold text-sm">{indexes?.sizePretty || '-'}</p></div>
                <div className="p-3 rounded-lg bg-muted/50 border text-center"><p className="text-xs text-muted-foreground">PostgreSQL</p><p className="font-bold text-sm font-mono">{serverInfo?.pgVersion || '-'}</p></div>
              </div>

              {isEstimate && (
                <div className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                  <div><p className="font-medium text-amber-700">Data estimasi</p><p className="text-amber-600">Ukuran database diestimasi berdasarkan jumlah baris per tabel.</p></div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Cloud className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-medium">Tidak dapat membaca kuota Supabase</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => refetchQuota()}><RefreshCw className="w-3 h-3 mr-1" /> Coba Lagi</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Database Table Sizes */}
      {(topTables || tableCounts) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Ukuran Tabel Database</CardTitle>
            <CardDescription>{topTables ? 'Berdasarkan ukuran data + index' : 'Jumlah record per tabel'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {topTables ? topTables.map((table: any, index: number) => {
              const rows = rowCounts?.[table.tableName] ?? null;
              const maxBytes = topTables[0]?.sizeBytes || 1;
              const widthPercent = (table.sizeBytes / maxBytes) * 100;
              return (
                <div key={table.tableName} className="space-y-1">
                  <div className="flex items-center justify-between p-2 border rounded-lg hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={cn("w-7 h-7 rounded flex items-center justify-center text-xs font-bold shrink-0", index === 0 ? "bg-red-100 dark:bg-red-900/30 text-red-600" : index === 1 ? "bg-amber-100 dark:bg-amber-900/30 text-amber-600" : index === 2 ? "bg-orange-100 dark:bg-orange-900/30 text-orange-600" : "bg-muted text-muted-foreground")}>{index + 1}</div>
                      <div className="min-w-0"><p className="text-sm font-medium font-mono truncate">{table.tableName}</p><p className="text-xs text-muted-foreground">{table.sizePretty}{rows !== null && <span className="ml-2">({rows.toLocaleString('id-ID')} rows)</span>}</p></div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0"><Badge variant="secondary" className="text-xs">Data: {table.dataSizePretty}</Badge><Badge variant="outline" className="text-xs">Index: {table.indexSizePretty}</Badge></div>
                  </div>
                  <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden ml-10"><div className="h-full rounded-full bg-violet-400/60 transition-all duration-500" style={{ width: `${Math.max(widthPercent, 2)}%` }} /></div>
                </div>
              );
            }) : tableCounts && Object.entries(tableCounts).sort(([,a],[,b]) => (b as number) - (a as number)).map(([name, count]) => (
              <div key={name} className="flex items-center justify-between p-2.5 border rounded-lg hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-3 min-w-0"><Table2 className="w-4 h-4 text-muted-foreground shrink-0" /><p className="text-sm font-medium font-mono truncate">{name}</p></div>
                <Badge variant="secondary" className="text-xs shrink-0">{(count as number).toLocaleString('id-ID')} rows</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Project Breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><FolderOpen className="w-4 h-4" /> Detail Penggunaan Proyek</CardTitle>
          <CardDescription>Ukuran setiap folder dalam proyek</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {project?.directories?.map((dir: any) => (
              <div key={dir.name} className="flex items-center justify-between p-2.5 border rounded-lg hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-3"><div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center"><HardDrive className="w-4 h-4 text-primary" /></div><div><p className="text-sm font-medium">{dir.name}</p></div></div>
                <div className="text-right"><p className="text-sm font-semibold">{dir.formatted}</p>{project?.totalSize > 0 && <p className="text-xs text-muted-foreground">{((dir.size / project.totalSize) * 100).toFixed(1)}%</p>}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ===================== */}
      {/* DATA BROWSER          */}
      {/* ===================== */}
      {user?.role === 'super_admin' && (
        <Card className="border-blue-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Table2 className="w-4 h-4 text-blue-500" /> Kelola Data Tabel</CardTitle>
            <CardDescription>Jelajahi dan hapus data dari setiap tabel. Klik tabel untuk melihat isinya.<br /><span className="text-red-600 font-medium">⚠️ Hapus hanya data yang sudah tidak diperlukan.</span></CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              {DATA_TABLES.map((tbl) => {
                const isActive = activeTable === tbl.id;
                const count = tableCounts?.[tbl.id] || 0;
                return (
                  <div key={tbl.id} className={cn("flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-all", isActive ? "border-blue-400 bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-200 dark:ring-blue-800" : "hover:bg-muted/50")} onClick={() => handleOpenTable(tbl.id)}>
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {isActive ? <ChevronDown className="w-4 h-4 text-blue-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                      <div className="shrink-0">{tbl.icon}</div>
                      <p className="text-sm font-medium truncate">{tbl.label}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0"><Badge variant="secondary" className="text-xs">{count.toLocaleString('id-ID')}</Badge>{count === 0 && <span className="text-[10px] text-muted-foreground">kosong</span>}</div>
                  </div>
                );
              })}
            </div>

            {activeTable && (
              <div className="border-2 border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-3 bg-blue-50/30 dark:bg-blue-950/20">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold flex items-center gap-2"><Eye className="w-4 h-4 text-blue-500" /> Data: {DATA_TABLES.find(t => t.id === activeTable)?.label}</h4>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setActiveTable(null); setSelectedRows([]); }}><X className="w-3 h-3 mr-1" /> Tutup</Button>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1"><Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" /><Input placeholder="Cari..." value={tableSearch} onChange={(e) => { setTableSearch(e.target.value); setTablePage(1); }} className="pl-8 h-8 text-sm" /></div>
                  <Select value={tableStatus} onValueChange={(v) => { setTableStatus(v); setTablePage(1); }}>
                    <SelectTrigger className="h-8 text-sm w-full sm:w-40"><Filter className="w-3.5 h-3.5 mr-1 text-muted-foreground" /><SelectValue placeholder="Semua Status" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Semua Status</SelectItem>
                      {activeTable === 'events' && <><SelectItem value="true">Sudah Dibaca</SelectItem><SelectItem value="false">Belum Dibaca</SelectItem></>}
                      {activeTable === 'finance_requests' && <><SelectItem value="pending">Menunggu</SelectItem><SelectItem value="approved">Disetujui</SelectItem><SelectItem value="processed">Selesai</SelectItem><SelectItem value="rejected">Ditolak</SelectItem></>}
                      {activeTable === 'salary_payments' && <><SelectItem value="pending">Menunggu</SelectItem><SelectItem value="approved">Disetujui</SelectItem><SelectItem value="paid">Dibayar</SelectItem><SelectItem value="rejected">Ditolak</SelectItem></>}
                      {activeTable === 'receivables' && <><SelectItem value="active">Aktif</SelectItem><SelectItem value="paid">Lunas</SelectItem><SelectItem value="cancelled">Dibatalkan</SelectItem><SelectItem value="bad_debt">Macet</SelectItem></>}
                      {activeTable === 'company_debts' && <><SelectItem value="active">Aktif</SelectItem><SelectItem value="paid">Lunas</SelectItem></>}
                      {activeTable === 'fund_transfers' && <><SelectItem value="pending">Menunggu</SelectItem><SelectItem value="approved">Disetujui</SelectItem><SelectItem value="completed">Selesai</SelectItem><SelectItem value="rejected">Ditolak</SelectItem></>}
                      {activeTable === 'transactions' && <><SelectItem value="pending">Menunggu</SelectItem><SelectItem value="approved">Disetujui</SelectItem><SelectItem value="cancelled">Dibatalkan</SelectItem></>}
                    </SelectContent>
                  </Select>
                </div>

                {tableData?.statusCounts && Object.keys(tableData.statusCounts).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(tableData.statusCounts).map(([status, count]) => (
                      <Badge key={status} variant={tableStatus === status ? 'default' : 'outline'} className="text-xs cursor-pointer" onClick={() => { setTableStatus(status); setTablePage(1); }}>{status}: {String(count)}</Badge>
                    ))}
                  </div>
                )}

                {tableLoading ? (
                  <div className="flex items-center justify-center py-6 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /><span className="text-sm">Memuat data...</span></div>
                ) : tableData?.records && tableData.records.length > 0 ? (
                  <>
                    {DATA_TABLES.find(t => t.id === activeTable)?.deletable && (
                      <div className="flex items-center justify-between p-2 bg-muted/50 rounded-lg border">
                        <div className="flex items-center gap-2">
                          <button onClick={handleSelectAll} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                            {selectedRows.length === tableData.records.length ? <CheckSquare className="w-4 h-4 text-blue-500" /> : <Square className="w-4 h-4" />}
                            <span>Pilih Semua ({selectedRows.length})</span>
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedRows.length > 0 && (
                            <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
                              <DialogTrigger asChild><Button variant="destructive" size="sm" className="h-7 text-xs"><Trash2 className="w-3 h-3 mr-1" /> Hapus {selectedRows.length} Data</Button></DialogTrigger>
                              <DialogContent className="sm:max-w-md w-[calc(100%-2rem)]">
                                <DialogHeader><DialogTitle>Hapus {selectedRows.length} Data?</DialogTitle><DialogDescription>Tindakan ini tidak dapat dibatalkan.</DialogDescription></DialogHeader>
                                <DialogFooter>
                                  <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Batal</Button>
                                  <Button variant="destructive" onClick={() => deleteRecordsMutation.mutate({ table: activeTable!, ids: selectedRows })} disabled={deleteRecordsMutation.isPending}>{deleteRecordsMutation.isPending ? 'Menghapus...' : 'Ya, Hapus'}</Button>
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>
                          )}
                          <Dialog>
                            <DialogTrigger asChild><Button variant="outline" size="sm" className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"><Trash2 className="w-3 h-3 mr-1" /> Hapus Semua ({tableData.total})</Button></DialogTrigger>
                            <DialogContent className="sm:max-w-md w-[calc(100%-2rem)]">
                              <DialogHeader><DialogTitle>Hapus Semua Data yang Terfilter?</DialogTitle><DialogDescription className="text-red-600">⚠️ SEMUA data dengan filter saat ini akan dihapus permanen. Total: {tableData.total} record.</DialogDescription></DialogHeader>
                              <DialogFooter>
                                <Button variant="outline">Batal</Button>
                                <Button variant="destructive" onClick={handleDeleteAllFiltered} disabled={deleteFilterMutation.isPending}>{deleteFilterMutation.isPending ? 'Menghapus...' : 'Ya, Hapus Semua'}</Button>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                        </div>
                      </div>
                    )}
                    <div className="space-y-1 max-h-96 overflow-y-auto">
                      {tableData.records.map((record: any) => {
                        const isSelected = selectedRows.includes(record.id);
                        const status = getRecordStatus(record, activeTable);
                        return (
                          <div key={record.id} className={cn("flex items-center gap-2 p-2.5 border rounded-lg transition-all cursor-pointer", isSelected ? "border-blue-400 bg-blue-50 dark:bg-blue-950/30" : "hover:bg-muted/30")} onClick={() => DATA_TABLES.find(t => t.id === activeTable)?.deletable && handleToggleRow(record.id)}>
                            {DATA_TABLES.find(t => t.id === activeTable)?.deletable && <div className="shrink-0">{isSelected ? <CheckSquare className="w-4 h-4 text-blue-500" /> : <Square className="w-4 h-4 text-muted-foreground/40" />}</div>}
                            <div className="flex-1 min-w-0"><p className="text-sm truncate">{getRecordLabel(record, activeTable)}</p><p className="text-xs text-muted-foreground">{record.created_at && format(new Date(record.created_at), 'dd/MM/yyyy HH:mm')}</p></div>
                            {status && getStatusBadge(status, activeTable)}
                          </div>
                        );
                      })}
                    </div>
                    {tableData.totalPages > 1 && (
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Halaman {tableData.page} dari {tableData.totalPages} ({tableData.total} total)</p>
                        <div className="flex items-center gap-1">
                          <Button variant="outline" size="icon" className="h-7 w-7" disabled={tableData.page <= 1} onClick={() => setTablePage(p => p - 1)}><ChevronLeft className="w-3.5 h-3.5" /></Button>
                          <Button variant="outline" size="icon" className="h-7 w-7" disabled={tableData.page >= tableData.totalPages} onClick={() => setTablePage(p => p + 1)}><ChevronRightIcon className="w-3.5 h-3.5" /></Button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-6 text-muted-foreground"><p className="text-sm">Tidak ada data</p></div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Data Cleanup - Quick Actions */}
      {user?.role === 'super_admin' && (
        <Card className="border-amber-500/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Trash2 className="w-4 h-4 text-amber-500" /> Pembersihan Cepat</CardTitle>
            <CardDescription>Hapus data yang tidak diperlukan secara cepat berdasarkan kategori.<br /><span className="text-amber-600 font-medium">Untuk pilih data satu per satu, gunakan &quot;Kelola Data Tabel&quot; di atas.</span></CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {CLEANUP_OPTIONS.map((opt) => {
              const isSelected = selectedCleanup.includes(opt.id);
              const disabled = opt.count === 0;
              return (
                <div key={opt.id} className={cn("flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-all", isSelected ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "hover:bg-muted/50", disabled && "opacity-40 cursor-not-allowed")} onClick={() => !disabled && toggleCleanup(opt.id)}>
                  <div className={cn("w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors", isSelected ? "bg-primary border-primary" : "border-muted-foreground/30")}>
                    {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                  </div>
                  <div className="flex-shrink-0">{opt.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2"><p className="text-sm font-medium">{opt.label}</p>{!opt.safe && <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">Semua</Badge>}</div>
                    <p className="text-xs text-muted-foreground truncate">{opt.description}</p>
                  </div>
                  <Badge variant="secondary" className="text-xs flex-shrink-0">{opt.id.startsWith('tmp_') || opt.id === 'next_cache' || opt.id === 'node_modules_cache' ? formatBytes(opt.count) : `${opt.count} record`}</Badge>
                </div>
              );
            })}
            {selectedCleanup.length > 0 && (
              <div className="flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div><p className="text-sm font-medium text-amber-800">{selectedCleanup.length} item dipilih untuk dihapus</p><p className="text-xs text-amber-600">Data ini tidak lagi diperlukan dan aman untuk dihapus</p></div>
                <Button variant="destructive" size="sm" disabled={cleanupMutation.isPending} onClick={() => cleanupMutation.mutate(selectedCleanup)}>
                  <Trash2 className="w-4 h-4 mr-1" />{cleanupMutation.isPending ? 'Menghapus...' : 'Hapus'}
                </Button>
              </div>
            )}
            {selectedCleanup.length === 0 && <p className="text-center text-sm text-muted-foreground py-2">Pilih data yang ingin dibersihkan di atas</p>}
          </CardContent>
        </Card>
      )}

      {/* Backup */}
      {user?.role === 'super_admin' && (
        <Card className="border-blue-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Download className="w-4 h-4 text-blue-500" /> Backup Data</CardTitle>
            <CardDescription>Unduh semua data dalam format JSON untuk backup atau pemindahan</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div><p className="text-sm font-medium">Backup Lengkap</p><p className="text-xs text-muted-foreground">Semua tabel database dalam satu file JSON</p></div>
              <Button variant="outline" size="sm" onClick={handleBackup} disabled={backupLoading}>
                {backupLoading ? <><RefreshCw className="w-4 h-4 mr-1 animate-spin" /> Mengunduh...</> : <><Download className="w-4 h-4 mr-1" /> Download</>}
              </Button>
            </div>
            <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
              <Shield className="w-4 h-4 text-blue-500 flex-shrink-0" />
              <p className="text-xs text-blue-700">Backup hanya mengunduh data, tidak menghapus apapun.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Refresh Button */}
      <div className="flex justify-center">
        <Button variant="outline" size="sm" onClick={() => { refetchStorage(); refetchQuota(); fetchStats(); fetchHealth(); }} className="gap-2">
          <RefreshCw className="w-3 h-3" /> Refresh Semua
        </Button>
      </div>
    </div>
  );
}
