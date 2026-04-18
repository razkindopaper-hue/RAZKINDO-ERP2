'use client';

import { useState, useEffect } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  Settings,
  Building2,
  Printer,
  MessageSquare,
  Plus,
  Trash2,
  Edit,
  X,
  Upload,
 Image,
  Monitor,
  Wifi,
  WifiOff,
  Bluetooth,
  AlertTriangle,
 FileText,
 MapPin,
  Phone,
  Activity,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingFallback } from '@/components/error-boundary';
import WhatsAppSettingsTab from './WhatsAppSettingsTab';
import MonitoringTab from './MonitoringTab';
import { apiFetch } from '@/lib/api-client';
import { requestBLEPrinter, connectBLEPrinter, wrapReceiptWithESCPOS, writeBLEChunks } from '@/lib/generate-invoice-pdf';
import type { Unit } from '@/types';

export default function SettingsModule() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [activeSettingsTab, setActiveSettingsTab] = useState('general');
  
  // Settings data
  const { data: settingsData, isLoading: settingsLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<{ settings: Record<string, any> }>('/api/settings')
  });
  
  const settings: Record<string, any> = settingsData?.settings || {};
  
  const updateSetting = async (key: string, value: any) => {
    try {
      await apiFetch(`/api/settings/${key}`, {
        method: 'PATCH',
        body: JSON.stringify({ value })
      });
      return true;
    } catch (err) {
      console.error(`Failed to save setting ${key}:`, err);
      return false;
    }
  };
  
  // Unit state
  const [showUnitForm, setShowUnitForm] = useState(false);
  const [editingUnit, setEditingUnit] = useState<Unit | null>(null);
  const [unitForm, setUnitForm] = useState({ name: '', address: '', phone: '' });
  const [unitLoading, setUnitLoading] = useState(false);
  const [deletingUnit, setDeletingUnit] = useState<Unit | null>(null);
  
  // General state
  const [companyName, setCompanyName] = useState('');
  const [companyLogo, setCompanyLogo] = useState('');
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [loginWarning, setLoginWarning] = useState('');
  
  // Printer state
  const [printerType, setPrinterType] = useState('browser');
  const [connectedPrinter, setConnectedPrinter] = useState<{ name: string; id: string } | null>(null);
  const [receiptHeader, setReceiptHeader] = useState('');
  const [receiptFooter, setReceiptFooter] = useState('');
  const [showLogoOnReceipt, setShowLogoOnReceipt] = useState(false);
  const [savingPrinter, setSavingPrinter] = useState(false);
  const [printerConnecting, setPrinterConnecting] = useState(false);
  
  // Sync settings to local state
  useEffect(() => {
    if (settingsData?.settings) {
      setCompanyName(settings.company_name || 'RAZKINDO GROUP');
      setCompanyLogo(settings.company_logo || '');
      setPrinterType(settings.printer_type || 'browser');
      setConnectedPrinter(settings.printer_device ? { name: settings.printer_device.name, id: settings.printer_device.id } : null);
      setReceiptHeader(settings.receipt_header || '');
      setReceiptFooter(settings.receipt_footer || 'Terima Kasih Atas Kunjungan Anda!');
      setShowLogoOnReceipt(settings.receipt_show_logo || false);
      setLoginWarning(settings.login_warning || '');
    }
  }, [settingsData]);
  
  // Save General settings
  const handleSaveGeneral = async () => {
    setSavingGeneral(true);
    const results = await Promise.all([
      updateSetting('company_name', companyName),
      updateSetting('company_logo', companyLogo),
      updateSetting('login_warning', loginWarning)
    ]);
    // Invalidate ALL settings queries (both authenticated and public) after all saves complete
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    queryClient.invalidateQueries({ queryKey: ['settings-public'] });
    if (results.every(Boolean)) {
      toast.success('Pengaturan umum berhasil disimpan');
    } else {
      toast.error('Beberapa pengaturan gagal disimpan. Coba lagi.');
    }
    setSavingGeneral(false);
  };
  
  // Logo upload handler
  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Ukuran logo maksimal 2MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCompanyLogo(ev.target?.result as string);
      toast.success('Logo berhasil dipilih');
    };
    reader.readAsDataURL(file);
  };
  
  // Save Printer settings
  const handleSavePrinter = async () => {
    setSavingPrinter(true);
    const results = await Promise.all([
      updateSetting('printer_type', printerType),
      updateSetting('printer_device', connectedPrinter),
      updateSetting('receipt_header', receiptHeader),
      updateSetting('receipt_footer', receiptFooter),
      updateSetting('receipt_show_logo', showLogoOnReceipt)
    ]);
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    if (results.every(Boolean)) {
      toast.success('Pengaturan printer berhasil disimpan');
    } else {
      toast.error('Beberapa pengaturan printer gagal disimpan. Coba lagi.');
    }
    setSavingPrinter(false);
  };
  
  // Connect Bluetooth printer
  const handleConnectBluetooth = async () => {
    setPrinterConnecting(true);
    try {
      const device = await requestBLEPrinter();
      toast.info(`Menghubungkan ke ${device.name}...`);
      await connectBLEPrinter(device);
      setConnectedPrinter({ name: device.name || 'Unknown Printer', id: device.id });
      toast.success(`Printer "${device.name}" berhasil terhubung!`);
      // Disconnect after verifying connection (printer stays paired)
      if (device.gatt?.connected) {
        device.gatt.disconnect();
      }
    } catch (err: any) {
      if (err.name === 'NotFoundError') toast.error('Printer tidak ditemukan');
      else if (err.name === 'SecurityError') toast.error('Permission ditolak');
      else if (err.name === 'NetworkError') toast.error('Koneksi gagal. Coba dekatkan ke printer.');
      else toast.error('Gagal: ' + err.message);
    } finally {
      setPrinterConnecting(false);
    }
  };
  
  // Disconnect printer
  const handleDisconnectPrinter = () => {
    setConnectedPrinter(null);
    toast.success('Printer terputus');
  };
  
  // Test print
  const handleTestPrint = async () => {
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const cName = companyName || 'RAZKINDO GROUP';
    const rFooter = receiptFooter || 'Terima Kasih!';
    const lines = [
      '================================',
      cName,
      receiptHeader ? receiptHeader.split('\n').join('\n') : 'Alamat Toko',
      '================================',
      `${dateStr}               ${timeStr}`,
      'No.       TEST-001',
      'Sales     Admin',
      'Customer  Walk-in',
      'Metode    CASH',
      '================================',
      'Produk A',
      ' 1 x 10.000',
      '                   10.000',
      'Produk B',
      ' 2 x 5.000',
      '                   10.000',
      '--------------------------------',
      'Total              20.000',
      'Tunai              20.000',
      'Kembali                0',
      '================================',
      `--${rFooter}--`,
      '================================',
    ];
    const receiptText = lines.join('\n');
    
    if (printerType === 'bluetooth_57' || printerType === 'bluetooth_80') {
      if (!connectedPrinter) {
        toast.error('Hubungkan printer Bluetooth terlebih dahulu');
        return;
      }
      try {
        const device = await requestBLEPrinter();
        toast.info(`Menghubungkan ke ${device.name}...`);
        const { characteristic } = await connectBLEPrinter(device);
        const data = wrapReceiptWithESCPOS(receiptText);
        await writeBLEChunks(characteristic, data);
        toast.success('Test print berhasil!');
        device.gatt?.disconnect();
      } catch (err: any) {
        if (err.name === 'NotFoundError') toast.error('Printer tidak ditemukan');
        else if (err.name === 'SecurityError') toast.error('Permission ditolak');
        else toast.error('Gagal test print: ' + (err.message || 'Unknown error'));
      }
    } else {
      const w = window.open('', '_blank', 'width=400,height=700');
      if (w) {
        w.document.write(`<html><head><style>@page{size:57mm auto;margin:2mm}body{font-family:'Courier New',monospace;font-size:10px;width:57mm;margin:0;padding:2mm;white-space:pre-wrap;line-height:1.3}</style></head><body>${receiptText}</body></html>`);
        w.document.close();
        w.print();
      }
    }
  };
  
  // Unit CRUD handlers
  const handleSaveUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unitForm.name.trim()) { toast.error('Nama unit wajib diisi'); return; }
    setUnitLoading(true);
    try {
      if (editingUnit) {
        await apiFetch(`/api/units/${editingUnit.id}`, {
          method: 'PATCH',
          body: JSON.stringify(unitForm)
        });
        toast.success('Unit berhasil diupdate');
      } else {
        await apiFetch('/api/units', {
          method: 'POST',
          body: JSON.stringify(unitForm)
        });
        toast.success('Unit berhasil ditambahkan');
      }
      setShowUnitForm(false);
      setEditingUnit(null);
      setUnitForm({ name: '', address: '', phone: '' });
      queryClient.invalidateQueries({ queryKey: ['units'] });
    } catch {
      toast.error('Gagal menyimpan unit');
    } finally {
      setUnitLoading(false);
    }
  };
  
  const handleDeleteUnit = async () => {
    if (!deletingUnit) return;
    try {
      await apiFetch(`/api/units/${deletingUnit.id}`, { method: 'DELETE' });
      toast.success('Unit berhasil dihapus');
      queryClient.invalidateQueries({ queryKey: ['units'] });
      setDeletingUnit(null);
    } catch {
      toast.error('Gagal menghapus unit');
    }
  };
  
  // Units query
  const { data: unitsData } = useQuery({
    queryKey: ['units', 'all'],
    queryFn: () => apiFetch<{ units: Unit[] }>('/api/units')
  });
  const allUnits = unitsData?.units || [];
  

  if (settingsLoading) {
    return <LoadingFallback message="Memuat pengaturan..." />;
  }
  
  return (
    <div className="space-y-4">
      <Tabs value={activeSettingsTab} onValueChange={setActiveSettingsTab}>
        {/* Mobile: Dropdown selector */}
        <div className="sm:hidden mb-4">
          <Select value={activeSettingsTab} onValueChange={setActiveSettingsTab}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Pilih menu" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="general">
                <span className="inline-flex items-center gap-2"><Settings className="w-4 h-4" /><span>Umum</span></span>
              </SelectItem>
              <SelectItem value="units">
                <span className="inline-flex items-center gap-2"><Building2 className="w-4 h-4" /><span>Unit</span></span>
              </SelectItem>
              <SelectItem value="printer">
                <span className="inline-flex items-center gap-2"><Printer className="w-4 h-4" /><span>Printer</span></span>
              </SelectItem>
              <SelectItem value="whatsapp">
                <span className="inline-flex items-center gap-2"><MessageSquare className="w-4 h-4" /><span>WhatsApp</span></span>
              </SelectItem>
              {user?.role === 'super_admin' && <SelectItem value="monitoring">
                <span className="inline-flex items-center gap-2"><Activity className="w-4 h-4" /><span>Monitoring</span></span>
              </SelectItem>}
            </SelectContent>
          </Select>
        </div>

        {/* Desktop: Tab buttons */}
        <TabsList className="hidden sm:flex w-full overflow-x-auto scrollbar-hide">
          <TabsTrigger value="general" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1"><Settings className="w-3 h-3 sm:w-4 sm:h-4" />Umum</TabsTrigger>
          <TabsTrigger value="units" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1"><Building2 className="w-3 h-3 sm:w-4 sm:h-4" />Unit</TabsTrigger>
          <TabsTrigger value="printer" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1"><Printer className="w-3 h-3 sm:w-4 sm:h-4" />Printer</TabsTrigger>
          <TabsTrigger value="whatsapp" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1"><MessageSquare className="w-3 h-3 sm:w-4 sm:h-4" />WA</TabsTrigger>
          {user?.role === 'super_admin' && <TabsTrigger value="monitoring" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1"><Activity className="w-3 h-3 sm:w-4 sm:h-4" />Monitoring</TabsTrigger>}
        </TabsList>
        
        {/* ===== TAB: UMUM ===== */}
        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Pengaturan Umum
              </CardTitle>
              <CardDescription>Nama perusahaan dan logo yang ditampilkan pada invoice dan struk</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Nama Perusahaan</Label>
                <Input
                  value={companyName}
                  onChange={e => setCompanyName(e.target.value)}
                  placeholder="Nama perusahaan"
                />
              </div>
              
              <div className="space-y-2">
                <Label>Logo Perusahaan</Label>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  {companyLogo ? (
                    <div className="relative">
                      <img src={companyLogo} alt="Company Logo" className="w-20 h-20 object-contain border rounded-lg p-1 bg-white" />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute -top-2 -right-2 h-6 w-6"
                        onClick={() => { setCompanyLogo(''); toast.success('Logo dihapus'); }}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="w-20 h-20 border-2 border-dashed rounded-lg flex flex-col items-center justify-center text-muted-foreground">
                      {/* eslint-disable-next-line jsx-a11y/alt-text */}
                      <Image className="w-8 h-8 mb-1" aria-hidden="true" />
                      <span className="text-xs">Belum ada</span>
                    </div>
                  )}
                  <div className="w-full sm:w-auto">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleLogoUpload}
                      className="hidden"
                      id="logo-upload"
                    />
                    <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => document.getElementById('logo-upload')?.click()}>
                      <Upload className="w-4 h-4 mr-2" />
                      {companyLogo ? 'Ganti Logo' : 'Upload Logo'}
                    </Button>
                    <p className="text-xs text-muted-foreground mt-1">PNG/JPG, maks. 2MB</p>
                  </div>
                </div>
              </div>
              
              <Separator />
              
              <div className="space-y-2">
                <Label>Peringatan di Halaman Login</Label>
                <Textarea
                  value={loginWarning}
                  onChange={e => setLoginWarning(e.target.value)}
                  placeholder="Teks peringatan yang ditampilkan di halaman login (opsional)"
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">Contoh: Sistem hanya untuk karyawan. Dilarang membagikan akun.</p>
              </div>
              
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                <div className="min-w-0">
                  <p className="font-medium">Versi Aplikasi</p>
                  <p className="text-sm text-muted-foreground">Razkindo ERP v1.0.0</p>
                </div>
                <Badge className="shrink-0 self-start">Production</Badge>
              </div>
            </CardContent>
            <CardFooter className="flex flex-col sm:flex-row justify-end border-t pt-4 gap-2">
              <Button onClick={handleSaveGeneral} disabled={savingGeneral} className="w-full sm:w-auto">
                {savingGeneral ? 'Menyimpan...' : 'Simpan Pengaturan'}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
        
        {/* ===== TAB: UNIT/CABANG ===== */}
        <TabsContent value="units" className="space-y-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Building2 className="w-4 h-4" />
                  Unit / Cabang
                </CardTitle>
                <CardDescription>Kelola unit atau cabang perusahaan</CardDescription>
              </div>
              <Button className="w-full sm:w-auto mt-3" size="sm" onClick={() => { setEditingUnit(null); setUnitForm({ name: '', address: '', phone: '' }); setShowUnitForm(true); }}>
                <Plus className="w-4 h-4 mr-1" />
                Tambah Unit
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {allUnits.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Building2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p>Belum ada unit/cabang</p>
                  </div>
                ) : (
                  allUnits.map((u: Unit) => (
                    <div key={u.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium truncate">{u.name}</p>
                          <Badge variant="outline" className="text-xs shrink-0">ID: {u.id.slice(0, 8)}</Badge>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-0.5 sm:gap-4 text-sm text-muted-foreground mt-1">
                          {u.address && <span className="flex items-center gap-1 min-w-0 truncate"><MapPin className="w-3 h-3 shrink-0" />{u.address}</span>}
                          {u.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3 shrink-0" />{u.phone}</span>}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0 self-end sm:self-center">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingUnit(u); setUnitForm({ name: u.name, address: u.address || '', phone: u.phone || '' }); setShowUnitForm(true); }}>
                          <Edit className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-600" onClick={() => setDeletingUnit(u)}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
          
          {/* Unit Form Dialog */}
          <Dialog open={showUnitForm} onOpenChange={setShowUnitForm}>
            <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
              <DialogHeader>
                <DialogTitle>{editingUnit ? 'Edit Unit' : 'Tambah Unit Baru'}</DialogTitle>
                <DialogDescription>{editingUnit ? 'Ubah informasi unit/cabang' : 'Isi detail unit/cabang baru'}</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSaveUnit} className="space-y-4">
                <div className="space-y-2">
                  <Label>Nama Unit *</Label>
                  <Input className="w-full" value={unitForm.name} onChange={e => setUnitForm({ ...unitForm, name: e.target.value })} placeholder="Contoh: Cabang Jakarta" required />
                </div>
                <div className="space-y-2">
                  <Label>Alamat</Label>
                  <Textarea className="w-full" value={unitForm.address} onChange={e => setUnitForm({ ...unitForm, address: e.target.value })} placeholder="Alamat lengkap" />
                </div>
                <div className="space-y-2">
                  <Label>Telepon</Label>
                  <Input className="w-full" value={unitForm.phone} onChange={e => setUnitForm({ ...unitForm, phone: e.target.value })} placeholder="Nomor telepon" />
                </div>
                <DialogFooter className="flex-col sm:flex-row gap-2">
                  <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setShowUnitForm(false)}>Batal</Button>
                  <Button type="submit" className="w-full sm:w-auto" disabled={unitLoading}>{unitLoading ? 'Menyimpan...' : editingUnit ? 'Update' : 'Simpan'}</Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          
          {/* Delete Confirm Dialog */}
          <Dialog open={!!deletingUnit} onOpenChange={(open) => { if (!open) setDeletingUnit(null); }}>
            <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
              <DialogHeader>
                <DialogTitle>Hapus Unit</DialogTitle>
                <DialogDescription>
                  Apakah Anda yakin ingin menonaktifkan unit &quot;{deletingUnit?.name}&quot;?
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="flex-col sm:flex-row gap-2">
                <Button variant="outline" className="w-full sm:w-auto" onClick={() => setDeletingUnit(null)}>Batal</Button>
                <Button variant="destructive" className="w-full sm:w-auto" onClick={handleDeleteUnit}>Hapus</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>
        
        {/* ===== TAB: WHATSAPP ===== */}
        <TabsContent value="whatsapp" className="space-y-4">
          <WhatsAppSettingsTab />
        </TabsContent>

        {/* ===== TAB: MONITORING ===== */}
        <TabsContent value="monitoring" className="space-y-4">
          <MonitoringTab />
        </TabsContent>

        {/* ===== TAB: PRINTER ===== */}
        <TabsContent value="printer" className="space-y-4">
          {/* Printer Type & Connection */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Printer className="w-4 h-4" />
                Koneksi Printer
              </CardTitle>
              <CardDescription>Pilih jenis printer dan hubungkan</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Jenis Printer</Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div
                    className={cn("p-4 border rounded-lg cursor-pointer transition-all hover:border-primary/50", printerType === 'browser' && "border-primary bg-primary/5 ring-2 ring-primary/20")}
                    onClick={() => setPrinterType('browser')}
                  >
                    <Monitor className="w-6 h-6 mb-2 text-blue-500" />
                    <p className="font-medium text-sm">Browser Print</p>
                    <p className="text-xs text-muted-foreground">Cetak via window browser</p>
                  </div>
                  <div
                    className={cn("p-4 border rounded-lg cursor-pointer transition-all hover:border-primary/50", printerType === 'bluetooth_57' && "border-primary bg-primary/5 ring-2 ring-primary/20")}
                    onClick={() => setPrinterType('bluetooth_57')}
                  >
                    <Printer className="w-6 h-6 mb-2 text-green-500" />
                    <p className="font-medium text-sm">Bluetooth 57x30</p>
                    <p className="text-xs text-muted-foreground">Struk thermal kecil</p>
                  </div>
                  <div
                    className={cn("p-4 border rounded-lg cursor-pointer transition-all hover:border-primary/50", printerType === 'bluetooth_80' && "border-primary bg-primary/5 ring-2 ring-primary/20")}
                    onClick={() => setPrinterType('bluetooth_80')}
                  >
                    <Printer className="w-6 h-6 mb-2 text-orange-500" />
                    <p className="font-medium text-sm">Bluetooth 80x80</p>
                    <p className="text-xs text-muted-foreground">Struk thermal besar</p>
                  </div>
                </div>
              </div>
              
              {(printerType === 'bluetooth_57' || printerType === 'bluetooth_80') && (
                <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">Printer Bluetooth</p>
                      {connectedPrinter ? (
                        <p className="text-sm text-green-600 flex items-center gap-1">
                          <Wifi className="w-3 h-3 shrink-0" />
                          <span className="truncate">Terhubung: {connectedPrinter.name}</span>
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">Belum terhubung</p>
                      )}
                    </div>
                    {connectedPrinter ? (
                      <Button variant="outline" size="sm" className="w-full sm:w-auto shrink-0" onClick={handleDisconnectPrinter}>
                        <WifiOff className="w-3 h-3 mr-1" />
                        Putuskan
                      </Button>
                    ) : (
                      <Button size="sm" className="w-full sm:w-auto shrink-0" onClick={handleConnectBluetooth} disabled={printerConnecting}>
                        <Bluetooth className="w-3 h-3 mr-1" />
                        {printerConnecting ? 'Menghubungkan...' : 'Hubungkan'}
                      </Button>
                    )}
                  </div>
                  {!navigator.bluetooth && (
                    <p className="text-xs text-yellow-600 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Browser ini tidak mendukung Bluetooth. Gunakan Chrome/Edge di desktop.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
          
          {/* Receipt Template Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Template Struk / Invoice
              </CardTitle>
              <CardDescription>Atur header, footer, dan logo pada struk</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between p-3 border rounded-lg gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm">Tampilkan Logo di Struk</p>
                  <p className="text-xs text-muted-foreground">{companyLogo ? 'Logo perusahaan akan ditampilkan' : 'Upload logo terlebih dahulu di tab Umum'}</p>
                </div>
                <Switch
                  checked={showLogoOnReceipt}
                  onCheckedChange={setShowLogoOnReceipt}
                  disabled={!companyLogo}
                />
              </div>
              
              <div className="space-y-2">
                <Label>Header Struk</Label>
                <Textarea
                  value={receiptHeader}
                  onChange={e => setReceiptHeader(e.target.value)}
                  placeholder="Teks tambahan di bagian atas struk (opsional)"
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">Maks. 3 baris. Kosongkan jika tidak perlu tambahan.</p>
              </div>
              
              <div className="space-y-2">
                <Label>Footer Struk</Label>
                <Textarea
                  value={receiptFooter}
                  onChange={e => setReceiptFooter(e.target.value)}
                  placeholder="Teks di bagian bawah struk"
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">Contoh: Terima Kasih Atas Kunjungan Anda!</p>
              </div>
              
              {/* Receipt Preview */}
              <div className="space-y-2">
                <Label>Preview Struk</Label>
                <div className={cn("border rounded-lg p-3 font-mono text-xs bg-white text-black w-full max-w-[280px] sm:max-w-sm mx-auto overflow-x-auto",
                  printerType === 'bluetooth_80' && "sm:!max-w-md"
                )}>
                  <pre className="whitespace-pre text-center leading-tight">
{`================================
${companyLogo && showLogoOnReceipt ? '[LOGO]' : ''}
${companyName}
${receiptHeader ? receiptHeader.split('\n').join('\n') : 'Alamat Toko'}
================================
${format(new Date(), 'dd/MM/yyyy')}          ${format(new Date(), 'HH:mm')}
No.       INV-001
Sales     Admin
Customer  Walk-in
Metode    CASH
================================
Produk A
 1 x 10.000
                   10.000
Produk B
 2 x 5.000
                   10.000
--------------------------------
Total              20.000
Tunai              20.000
Kembali                0
================================
--${(receiptFooter || 'Terima Kasih!')}--
================================`}
                  </pre>
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex flex-col sm:flex-row justify-between border-t pt-4 gap-2">
              <Button variant="outline" className="w-full sm:w-auto" onClick={handleTestPrint}>
                <Printer className="w-4 h-4 mr-2" />
                Test Print
              </Button>
              <Button className="w-full sm:w-auto" onClick={handleSavePrinter} disabled={savingPrinter}>
                {savingPrinter ? 'Menyimpan...' : 'Simpan Pengaturan'}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
