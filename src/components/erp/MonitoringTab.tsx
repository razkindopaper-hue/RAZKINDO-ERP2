'use client';

import { useState } from 'react';
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
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
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
  if (days > 0) return `${days} hari ${hours} jam ${minutes} menit`;
  if (hours > 0) return `${hours} jam ${minutes} menit`;
  return `${minutes} menit`;
}

function getUsageColor(percent: number): string {
  if (percent >= 80) return 'text-red-500';
  if (percent >= 60) return 'text-yellow-500';
  return 'text-green-500';
}

function getUsageBgColor(percent: string): string {
  const p = parseInt(percent);
  if (p >= 80) return '[&>div]:bg-red-500';
  if (p >= 60) return '[&>div]:bg-yellow-500';
  return '[&>div]:bg-green-500';
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

  // Fetch monitoring data
  const { data, isLoading, isRefetching, refetch } = useQuery<MonitoringData>({
    queryKey: ['system-info'],
    queryFn: () => apiFetch<MonitoringData>('/api/system/info'),
    refetchInterval: 30000,
    enabled: isSuperAdmin,
  });

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
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="w-5 h-5" />
            Monitoring Sistem
          </h2>
          <p className="text-sm text-muted-foreground">
            Pantau resource server & penyimpanan Supabase
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`w-4 h-4 mr-1 ${isRefetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* ===== SYSTEM RESOURCES ===== */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="w-4 h-4" />
            Sumber Daya Server
            {sys?.isDocker && <Badge variant="outline" className="text-xs">Docker</Badge>}
          </CardTitle>
          <CardDescription>
            CPU, RAM, Disk & uptime — {sys?.hostname || '...'} ({sys?.platform || '...'})
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : sys ? (
            <>
              {/* CPU */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">CPU</span>
                    <Badge variant="outline" className="text-xs">{sys.cpuCores} core</Badge>
                    <span className="text-xs text-muted-foreground hidden sm:inline truncate max-w-[200px]">{sys.cpuModel}</span>
                  </div>
                  <span className={`text-sm font-bold ${getUsageColor(sys.cpuUsage)}`}>{sys.cpuUsage}%</span>
                </div>
                <Progress value={sys.cpuUsage} className={`h-2.5 ${getUsageBgColor(String(sys.cpuUsage))}`} />
                {sys.loadAvg && sys.loadAvg.length === 3 && (
                  <p className="text-xs text-muted-foreground">
                    Load: {sys.loadAvg[0]} / {sys.loadAvg[1]} / {sys.loadAvg[2]}
                  </p>
                )}
              </div>

              {/* RAM */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MemoryStick className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">RAM</span>
                  </div>
                  <span className={`text-sm font-bold ${getUsageColor(sys.memoryUsagePercent)}`}>{sys.memoryUsagePercent}%</span>
                </div>
                <Progress value={sys.memoryUsagePercent} className={`h-2.5 ${getUsageBgColor(String(sys.memoryUsagePercent))}`} />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Terpakai: {formatBytes(sys.usedMemory)}</span>
                  <span>Total: {formatBytes(sys.totalMemory)}</span>
                  <span>Bebas: {formatBytes(sys.freeMemory)}</span>
                </div>
              </div>

              {/* Disk */}
              {sys.disk.total > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Disk</span>
                    </div>
                    <span className={`text-sm font-bold ${getUsageColor(sys.disk.usagePercent)}`}>{sys.disk.usagePercent}%</span>
                  </div>
                  <Progress value={sys.disk.usagePercent} className={`h-2.5 ${getUsageBgColor(String(sys.disk.usagePercent))}`} />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Terpakai: {formatBytes(sys.disk.used)}</span>
                    <span>Total: {formatBytes(sys.disk.total)}</span>
                    <span>Bebas: {formatBytes(sys.disk.available)}</span>
                  </div>
                </div>
              )}

              {/* Uptime */}
              <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Uptime</span>
                </div>
                <span className="text-sm text-muted-foreground">{formatUptime(sys.uptime)}</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">Gagal memuat data sistem</p>
          )}
        </CardContent>
      </Card>

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
