'use client';

import { useState, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import {
  Megaphone, Users, Building2, UserCheck, Send, Loader2,
  AlertTriangle, CheckCircle2, X, Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

// ==================== TYPES ====================
interface UnitOption {
  id: string;
  name: string;
  _count: { customers: number };
}

interface BroadcastPreviewData {
  units: UnitOption[];
  totalCustomers: number;
  isSuperAdmin: boolean;
}

interface CustomerOption {
  id: string;
  name: string;
  phone?: string;
  unitName?: string;
}

// ==================== COMPONENT ====================
interface BroadcastDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function BroadcastDialog({ open, onOpenChange }: BroadcastDialogProps) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  const [scope, setScope] = useState<'all' | 'unit' | 'selected'>('all');
  const [unitId, setUnitId] = useState<string>('');
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');

  // Fetch broadcast preview data (units + total customers)
  const { data: previewData, isLoading: previewLoading } = useQuery<BroadcastPreviewData>({
    queryKey: ['chat-broadcast-preview'],
    queryFn: () => apiFetch('/api/chat/broadcast'),
    enabled: open,
  });

  // Fetch customers for selected scope
  const { data: customersData, isLoading: customersLoading } = useQuery<{ customers: CustomerOption[] }>({
    queryKey: ['broadcast-customers', scope, unitId],
    queryFn: () => {
      if (scope === 'unit' && unitId) {
        return apiFetch(`/api/customers?unitId=${unitId}`);
      }
      return apiFetch('/api/customers');
    },
    enabled: open && scope === 'selected',
  });

  // Broadcast mutation
  const broadcastMutation = useMutation({
    mutationFn: (data: { message: string; messageType: string; scope: string; unitId?: string; customerIds?: string[] }) =>
      apiFetch<{ success: boolean; sent: number; skipped: number; totalTargets: number }>('/api/chat/broadcast', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (result) => {
      toast.success(`Broadcast berhasil dikirim ke ${result.sent} pelanggan`, {
        description: result.skipped > 0 ? `${result.skipped} pelanggan dilewati` : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] });
      // Reset form
      setMessage('');
      setSelectedCustomerIds([]);
      setScope('all');
      setUnitId('');
      setCustomerSearch('');
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast.error('Gagal mengirim broadcast', {
        description: err.message || 'Terjadi kesalahan',
      });
    },
  });

  const units = previewData?.units || [];
  const totalCustomers = previewData?.totalCustomers || 0;
  const isSuperAdmin = previewData?.isSuperAdmin ?? false;

  const allCustomers = customersData?.customers || [];
  const filteredCustomers = customerSearch
    ? allCustomers.filter(
        (c) =>
          c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
          (c.phone && c.phone.includes(customerSearch))
      )
    : allCustomers;

  // Calculate target count
  const getTargetCount = useCallback((): number => {
    if (scope === 'all') return totalCustomers;
    if (scope === 'unit') {
      const unit = units.find((u) => u.id === unitId);
      return unit?._count?.customers || 0;
    }
    return selectedCustomerIds.length;
  }, [scope, totalCustomers, units, unitId, selectedCustomerIds.length]);

  const targetCount = getTargetCount();

  const toggleCustomer = (id: string) => {
    setSelectedCustomerIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const handleOpenConfirm = () => {
    if (!message.trim()) {
      toast.error('Pesan wajib diisi');
      return;
    }
    if (scope === 'unit' && !unitId) {
      toast.error('Pilih unit terlebih dahulu');
      return;
    }
    if (scope === 'selected' && selectedCustomerIds.length === 0) {
      toast.error('Pilih minimal satu pelanggan');
      return;
    }
    setShowConfirm(true);
  };

  const handleSend = () => {
    broadcastMutation.mutate({
      message: message.trim(),
      messageType: 'text',
      scope,
      unitId: scope === 'unit' ? unitId : undefined,
      customerIds: scope === 'selected' ? selectedCustomerIds : undefined,
    });
    setShowConfirm(false);
  };

  const isSending = broadcastMutation.isPending;

  const resetForm = () => {
    setMessage('');
    setSelectedCustomerIds([]);
    setScope('all');
    setUnitId('');
    setCustomerSearch('');
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
        <DialogContent className="sm:max-w-[540px] max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="w-5 h-5 text-amber-500" />
              Broadcast Pesan
            </DialogTitle>
            <DialogDescription>
              Kirim pesan ke banyak pelanggan sekaligus melalui chat
            </DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Scope Selection */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Target Penerima</Label>
                <div className="grid grid-cols-1 gap-2">
                  {/* All customers */}
                  <button
                    type="button"
                    disabled={!isSuperAdmin}
                    onClick={() => setScope('all')}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                      scope === 'all'
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/20'
                        : 'border-border hover:bg-muted/50',
                      !isSuperAdmin && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <div className={cn(
                      'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                      scope === 'all' ? 'bg-amber-500 text-white' : 'bg-muted'
                    )}>
                      <Users className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Semua Pelanggan</p>
                      <p className="text-xs text-muted-foreground">
                        {totalCustomers} pelanggan aktif
                        {!isSuperAdmin && ' (Super admin only)'}
                      </p>
                    </div>
                    {scope === 'all' && (
                      <CheckCircle2 className="w-5 h-5 text-amber-500 shrink-0" />
                    )}
                  </button>

                  {/* Unit */}
                  <button
                    type="button"
                    onClick={() => setScope('unit')}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                      scope === 'unit'
                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20'
                        : 'border-border hover:bg-muted/50'
                    )}
                  >
                    <div className={cn(
                      'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                      scope === 'unit' ? 'bg-emerald-500 text-white' : 'bg-muted'
                    )}>
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Per Unit</p>
                      <p className="text-xs text-muted-foreground">
                        Kirim ke pelanggan di unit tertentu
                      </p>
                    </div>
                    {scope === 'unit' && (
                      <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                    )}
                  </button>

                  {/* Selected */}
                  <button
                    type="button"
                    onClick={() => setScope('selected')}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                      scope === 'selected'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
                        : 'border-border hover:bg-muted/50'
                    )}
                  >
                    <div className={cn(
                      'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                      scope === 'selected' ? 'bg-blue-500 text-white' : 'bg-muted'
                    )}>
                      <UserCheck className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Pilih Pelanggan</p>
                      <p className="text-xs text-muted-foreground">
                        Pilih pelanggan secara manual
                      </p>
                    </div>
                    {scope === 'selected' && (
                      <CheckCircle2 className="w-5 h-5 text-blue-500 shrink-0" />
                    )}
                  </button>
                </div>
              </div>

              {/* Unit selector */}
              {scope === 'unit' && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Pilih Unit</Label>
                  <Select value={unitId} onValueChange={setUnitId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pilih unit..." />
                    </SelectTrigger>
                    <SelectContent>
                      {units.map((unit) => (
                        <SelectItem key={unit.id} value={unit.id}>
                          {unit.name} ({unit._count.customers} pelanggan)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Customer multi-select */}
              {scope === 'selected' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">
                      Pilih Pelanggan ({selectedCustomerIds.length} dipilih)
                    </Label>
                    {selectedCustomerIds.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => setSelectedCustomerIds([])}
                      >
                        Hapus semua
                      </Button>
                    )}
                  </div>

                  {selectedCustomerIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedCustomerIds.map((id) => {
                        const c = allCustomers.find((cust) => cust.id === id);
                        if (!c) return null;
                        return (
                          <Badge
                            key={id}
                            variant="secondary"
                            className="cursor-pointer gap-1 pr-1 hover:bg-destructive/10"
                            onClick={() => toggleCustomer(id)}
                          >
                            {c.name}
                            <X className="w-3 h-3" />
                          </Badge>
                        );
                      })}
                    </div>
                  )}

                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      placeholder="Cari pelanggan..."
                      className="pl-8 h-8 text-xs"
                    />
                  </div>

                  <ScrollArea className="h-48 rounded-md border">
                    {customersLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : filteredCustomers.length === 0 ? (
                      <div className="flex items-center justify-center py-8 text-center px-4">
                        <p className="text-xs text-muted-foreground">
                          {customerSearch ? 'Tidak ditemukan' : 'Tidak ada pelanggan'}
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y">
                        {filteredCustomers.map((customer) => {
                          const isSelected = selectedCustomerIds.includes(customer.id);
                          return (
                            <button
                              key={customer.id}
                              type="button"
                              onClick={() => toggleCustomer(customer.id)}
                              className={cn(
                                'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/50',
                                isSelected && 'bg-emerald-50 dark:bg-emerald-950/20'
                              )}
                            >
                              <Checkbox checked={isSelected} className="pointer-events-none" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm truncate">{customer.name}</p>
                                {customer.phone && (
                                  <p className="text-[11px] text-muted-foreground">{customer.phone}</p>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              )}

              <Separator />

              {/* Message Input */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Pesan Broadcast</Label>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Tulis pesan broadcast..."
                  className="min-h-[100px] resize-none text-sm"
                  disabled={isSending}
                />
                <p className="text-[11px] text-muted-foreground text-right">
                  {message.length} karakter
                </p>
              </div>

              {/* Preview summary */}
              <div className="rounded-lg bg-muted/50 p-3 space-y-1.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  Ringkasan Broadcast
                </div>
                <div className="text-xs text-muted-foreground space-y-1 ml-6">
                  <p>
                    Target:{' '}
                    <span className="font-medium text-foreground">{targetCount} pelanggan</span>
                  </p>
                  <p>
                    Scope:{' '}
                    <span className="font-medium text-foreground">
                      {scope === 'all' ? 'Semua Pelanggan' : scope === 'unit' ? units.find((u) => u.id === unitId)?.name || '-' : `${selectedCustomerIds.length} pelanggan dipilih`}
                    </span>
                  </p>
                  <p>
                    Pesan akan ditandai dengan <span className="font-mono text-amber-600">[Broadcast]</span> di chat pelanggan
                  </p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="pt-3 border-t">
            <Button variant="outline" onClick={() => { resetForm(); onOpenChange(false); }} disabled={isSending}>
              Batal
            </Button>
            <Button
              onClick={handleOpenConfirm}
              disabled={isSending || !message.trim() || targetCount === 0}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {isSending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Mengirim...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Kirim Broadcast
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Konfirmasi Broadcast</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Anda akan mengirim pesan ke <strong>{targetCount} pelanggan</strong>.
                </p>
                <div className="rounded-lg bg-muted p-3">
                  <p className="text-sm font-medium mb-1">Pesan:</p>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                    {message.trim()}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pesan ini akan muncul di setiap chat pelanggan sebagai pesan broadcast.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSending}>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSend}
              disabled={isSending}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {isSending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Mengirim...
                </>
              ) : (
                'Ya, Kirim Broadcast'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
