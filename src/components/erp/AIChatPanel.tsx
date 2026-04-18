'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-client';
import {
  X, Bot, Trash2, Send, Plus, Download, Volume2, VolumeX,
  Megaphone, Users, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp,
  Search, Wrench, Image, AlertTriangle, ShieldCheck
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { formatCurrency, escapeHtml } from '@/lib/erp-helpers';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
  actionType?: 'discrepancy_analyze' | 'discrepancy_adjust' | 'root_cause' | 'promo_image';
  actionData?: any;
}

interface BroadcastTarget {
  id: string;
  name: string;
  phone?: string;
  jid?: string;
}

export default function AIChatPanel() {
  const { user } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingType, setLoadingType] = useState<'general' | 'financial'>('general');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'broadcast'>('chat');

  // TTS state
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  // Quotation dialog state
  const [showQuotation, setShowQuotation] = useState(false);
  const [quoData, setQuoData] = useState<any>(null);
  const [quoItems, setQuoItems] = useState<any[]>([]);
  const [quoCustomer, setQuoCustomer] = useState('');

  // MOU dialog state
  const [showMou, setShowMou] = useState(false);
  const [mouData, setMouData] = useState<any>(null);
  const [mouPartner, setMouPartner] = useState('');
  const [mouType, setMouType] = useState('Distribusi');
  const [mouDuration, setMouDuration] = useState('1 Tahun');
  const [mouScope, setMouScope] = useState('');
  const [mouGenerating, setMouGenerating] = useState(false);

  // Broadcast state
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastLoading, setBroadcastLoading] = useState(false);
  const [broadcastTargets, setBroadcastTargets] = useState<{ customers: BroadcastTarget[]; employees: BroadcastTarget[]; groups: BroadcastTarget[] } | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [targetAllType, setTargetAllType] = useState<'all_customers' | 'all_employees' | null>(null);
  const [broadcastResult, setBroadcastResult] = useState<{ sent: number; failed: number; results: any[] } | null>(null);
  const [showBroadcastTargetSelect, setShowBroadcastTargetSelect] = useState(false);

  // Discrepancy & Promo state
  const [promoLoading, setPromoLoading] = useState(false);
  const [discrepancyLoading, setDiscrepancyLoading] = useState(false);
  const [promoProducts, setPromoProducts] = useState<any[]>([]);

  const isSuperAdmin = user?.role === 'super_admin';

  // Client-side financial analysis detection (mirrors server-side logic)
  function isFinancialAnalysis(msg: string): boolean {
    const q = msg.toLowerCase();
    return !!(
      q.match(/hpp|harga\s*pokok|biaya\s*produksi/) ||
      q.match(/profit\s*(di\s*tangan|terkumpul|sudah|yang)|laba\s*(di\s*tangan|terkumpul)/) ||
      q.match(/uang\s*(yang|sudah)\s*(di\s*tangan|terkumpul|tersedia)/) ||
      q.match(/saran\s*(beli|restock|pengadaan)/) ||
      q.match(/rekomendasi\s*(beli|restock|stok|pengadaan)/) ||
      q.match(/apa\s*(yang|saja)\s*(harus|perlu|sebaiknya)\s*di\s*(beli|restock|adakan)/) ||
      q.match(/pattern|pola\s*(penjualan|beli)/) ||
      q.match(/tren\s*(penjualan|sales|omset)/) ||
      q.match(/analisa\s*(penjualan|keuangan|bisnis|financial)/) ||
      q.match(/analisis\s*(penjualan|keuangan|bisnis|financial)/) ||
      q.match(/prediksi|predict|forecast/) ||
      q.match(/kemungkinan.*(konsumen|customer|pelanggan).*(beli|order|pesan)/) ||
      q.match(/uang\s*masuk|arus\s*kas|cash\s*flow/) ||
      q.match(/selisih|discrepancy|ketidaksesuaian/) ||
      q.match(/audit|telusuri|investigasi/) ||
      q.match(/keuangan\s*(sehat|baik|buruk|kondisi)/) ||
      q.match(/kesehatan\s*(keuangan|bisnis|financial)/) ||
      q.match(/review\s*(keuangan|financial|bisnis)/) ||
      q.match(/laporan\s*(keuangan|financial|lengkap|komprehensif)/) ||
      q.match(/aset|asset\s*(value|nilai)/) ||
      q.match(/margin\s*(keuntungan|profit)/) ||
      q.match(/hutang|debt|piutang\s*(total|ringkasan)/) ||
      q.match(/buat\s*(gambar\s*)?promo/) ||
      q.match(/generate\s*promo/) ||
      q.match(/cek\s*selisih/) ||
      q.match(/perbaiki\s*selisih/) ||
      q.match(/penyebab\s*selisih/)
    );
  }

  const quickPrompts = [
    { label: '💰 Jualan hari ini', query: 'penjualan hari ini' },
    { label: '📈 Jualan bulan ini', query: 'penjualan bulan ini' },
    { label: '👥 Per sales', query: 'penjualan per sales' },
    ...(isSuperAdmin ? [
      { label: '🔍 Cek HPP & Profit', query: 'cek uang hpp yang terkumpul dan profit yang sudah di tangan' },
      { label: '🛒 Saran restock', query: 'saran item barang apa saja yang harus aku beli berdasarkan pola penjualan' },
      { label: '📊 Analisa penjualan', query: 'analisa penjualan 3 bulan terakhir berikan insight dan rekomendasi' },
      { label: '🎯 Prediksi konsumen', query: 'prediksi konsumen mana yang kemungkinan besar akan beli minggu depan' },
      { label: '💵 Audit uang masuk', query: 'audit semua uang masuk dan telusuri apakah ada selisih atau masalah' },
      { label: '🏥 Cek kesehatan keuangan', query: 'bagaimana kondisi kesehatan keuangan kita saat ini berikan analisis komprehensif' },
      { label: '🔍 Cek selisih data', query: 'cek apakah ada selisih di data keuangan kita' },
      { label: '🛠️ Perbaiki selisih', query: 'analisa dan rekomendasikan perbaikan untuk selisih data yang ditemukan' },
      { label: '🔎 Penyebab selisih', query: 'cari tahu penyebab selisih di data keuangan kita' },
      { label: '🎨 Buat gambar promo', query: 'buat gambar promo untuk produk terlaris' },
    ] : []),
    { label: '📋 Piutang', query: 'total piutang' },
    { label: '📦 Stok produk', query: 'stok produk' },
    { label: '⚠️ Stok rendah', query: 'stok rendah' },
    { label: '📝 Buat penawaran', query: 'penawaran' },
    { label: '📄 Buat MOU', query: 'buat mou' },
  ];

  // AI Action buttons (super_admin only)
  const aiActions = isSuperAdmin ? [
    { label: '🔍 Analisa Selisih', icon: Search, action: 'discrepancy_analyze', color: 'text-amber-600' },
    { label: '🔧 Sesuaikan Selisih', icon: Wrench, action: 'discrepancy_adjust', color: 'text-blue-600' },
    { label: '🔎 Cari Penyebab', icon: AlertTriangle, action: 'root_cause', color: 'text-red-600' },
    { label: '🎨 Gambar Promo', icon: Image, action: 'promo_image', color: 'text-purple-600' },
  ] : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, broadcastResult]);

  useEffect(() => {
    if (isOpen && activeTab === 'chat') {
      const timer = setTimeout(() => inputRef.current?.focus(), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, activeTab]);

  useEffect(() => {
    if (messages.length === 0 && isOpen && activeTab === 'chat') {
      setMessages([{
        role: 'assistant',
        content: isSuperAdmin
          ? 'Halo! 👋 Saya **Asisten Keuangan Razkindo** — AI Financial Analyst.\n\n🧠 Kini dengan kecerdasan finansial lengkap!\n\n**Analisis Keuangan:**\n• 🔍 Cek HPP & Profit terkumpul\n• 🛒 Saran restock berdasarkan pola penjualan\n• 📊 Analisa tren penjualan (bulanan/kuartal)\n• 🎯 Prediksi konsumen yang akan order\n• 💵 Audit uang masuk & deteksi selisih\n• 🏥 Cek kesehatan keuangan\n\n**🆕 AI Discrepancy Tools:**\n• 🔍 **Cek Selisih Data** — Deep audit inkonsistensi\n• 🛠️ **Perbaiki Selisih** — Rekomendasi fix otomatis\n• 🔎 **Penyebab Selisih** — Root cause analysis\n• 🎨 **Gambar Promo** — Generate gambar promosi produk\n\n**AI Action Buttons (di bawah chat):**\n• Gunakan tombol ⚡ untuk aksi cepat\n• Atau ketik perintah langsung\n\n**Data Cepat:**\n• 💰 Penjualan hari/minggu/bulan\n• 👥 Per sales • 📋 Piutang\n• 📦 Stok • 📝 Penawaran • 📄 MOU\n\n📢 Tab **Broadcast** untuk kirim promo!'
          : 'Halo! 👋 Saya **Asisten Data Razkindo**.\n\nKlik tombol cepat atau tanya apa saja:\n• 💰 Penjualan hari/minggu/bulan\n• 👥 Penjualan per sales\n• 📋 Piutang & konsumen\n• 📦 Stok produk\n• 📝 Buat penawaran\n• 📄 Buat MOU\n\n📢 Klik tab **Broadcast** untuk kirim promo!'
      }]);
    }
  }, [isOpen, messages.length, activeTab]);

  // Auto-TTS on new assistant message
  const ttsEnabledRef = useRef(ttsEnabled);
  ttsEnabledRef.current = ttsEnabled;

  useEffect(() => {
    if (ttsEnabledRef.current && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        handleTTS(lastMsg.content);
      }
    }
  }, [messages.length]);

  const handleTTS = async (text: string) => {
    // Stop any current playback
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
      setPlayingId(null);
    }

    // Strip markdown for speech
    const cleanText = text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/[📊📈💰📦📋⚠️🟢🔴🤖👤📝✅⏳📰🏷️]/g, '')
      .replace(/---/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ', ')
      .trim()
      .slice(0, 1000);

    if (!cleanText) return;

    try {
      const idx = messages.findIndex(m => m.content === text);
      setPlayingId(idx >= 0 ? idx : -1);

      const res = await fetch('/api/ai/tts?XTransformPort=3000', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${(() => { try { const s = JSON.parse(localStorage.getItem('razkindo-auth') || '{}'); return s?.state?.token || ''; } catch { return ''; } })()}` },
        body: JSON.stringify({ text: cleanText, voice: 'tongtong', speed: 1.0 })
      });

      if (!res.ok) throw new Error('TTS failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudioRef.current = audio;
      audio.onended = () => { setPlayingId(null); URL.revokeObjectURL(url); };
      audio.onerror = () => { setPlayingId(null); URL.revokeObjectURL(url); };
      audio.play().catch(() => setPlayingId(null));
    } catch {
      setPlayingId(null);
    }
  };

  const stopTTS = () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    setPlayingId(null);
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;
    const userMsg = text.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setLoading(true);

    // Check for promo image command
    const promoMatch = userMsg.toLowerCase().match(/^promo\s+(.+)/);
    if (promoMatch && isSuperAdmin) {
      const productName = promoMatch[1].trim();
      // Check if it's a number reference to the last loaded products
      const numMatch = productName.match(/^(\d+)$/);
      if (numMatch && promoProducts.length > 0) {
        const idx = parseInt(numMatch[1]) - 1;
        if (idx >= 0 && idx < promoProducts.length) {
          setLoading(false);
          await generatePromoImage(promoProducts[idx]);
          return;
        }
      }
      // Try to find product by name
      const found = promoProducts.find((p: any) =>
        p.name?.toLowerCase().includes(productName.toLowerCase())
      );
      if (found) {
        setLoading(false);
        await generatePromoImage(found);
        return;
      }
      // Generate with custom name if no product found
      setPromoLoading(true);
      try {
        const data = await apiFetch<{ success: boolean; imageUrl: string }>('/api/ai/promo-image', {
          method: 'POST',
          body: JSON.stringify({ productName, customPrompt: undefined }),
        });
        if (data.success && data.imageUrl) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `✅ Gambar promo untuk **${productName}** berhasil dibuat!\n\nKlik gambar untuk download.`,
            imageUrl: data.imageUrl,
            actionType: 'promo_image',
          }]);
        } else {
          setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal generate gambar promo. Coba lagi.' }]);
        }
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal generate gambar promo. Coba lagi.' }]);
      } finally {
        setPromoLoading(false);
        setLoading(false);
      }
      return;
    }

    try {
      setLoadingType(isSuperAdmin && isFinancialAnalysis(userMsg) ? 'financial' : 'general');
      const data = await apiFetch<{ success: boolean; isQuotation?: boolean; isMou?: boolean; isFinancial?: boolean; isPromoIntent?: boolean; promoProducts?: any[]; reply: string; error?: string }>('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message: userMsg, history: messages }),
      });

      if (data.success) {
        if (data.isQuotation) {
          let parsed: any;
          try { parsed = JSON.parse(data.reply); } catch {
            setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Format quotation gagal.' }]);
            return;
          }
          openQuotationDialog(parsed.customerName);
          setMessages(prev => [...prev, { role: 'assistant', content: '📝 Silakan isi form penawaran di dialog yang terbuka.' }]);
        } else if (data.isMou) {
          let parsed: any;
          try { parsed = JSON.parse(data.reply); } catch {
            setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Format MOU gagal.' }]);
            return;
          }
          openMouDialog(parsed.partnerName);
          setMessages(prev => [...prev, { role: 'assistant', content: '📄 Silakan isi form MOU di dialog yang terbuka.' }]);
        } else if (data.isPromoIntent && data.promoProducts) {
          // Store promo products for later reference
          setPromoProducts(data.promoProducts);
          setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
        } else {
          setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
        }
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${data.error || 'Gagal.'}` }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal mengambil data.' }]);
    } finally {
      setLoading(false);
      setLoadingType('general');
    }
  };

  // ============ QUOTATION ============

  const openQuotationDialog = async (customerName: string) => {
    try {
      const data = await apiFetch('/api/ai/quotation', { method: 'POST', body: JSON.stringify({ customerName, items: [] }) }) as any;
      if (data.success) {
        setQuoData(data);
        setQuoCustomer(customerName);
        setQuoItems([{ productId: '', productName: '', qty: 0, unit: 'pcs', price: 0, note: 'Harga nego' }]);
        setShowQuotation(true);
      }
    } catch { /* ignore */ }
  };

  const generateQuotationPDF = async () => {
    const validItems = quoItems.filter(it => it.productName && it.qty > 0);
    if (validItems.length === 0) return;

    const { default: jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;
    const doc = new jsPDF('p', 'mm', 'a4');
    const company = quoData?.company || {};
    const customer = quoData?.customer || { name: quoCustomer, phone: '', address: '' };
    const total = validItems.reduce((s: number, it: any) => s + (it.qty * it.price), 0);
    const companyName = company.name || 'Razkindo';
    const companyAddress = company.address || '';
    const companyPhone = company.phone || '';
    const companyEmail = company.email || '';

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 15;
    const contentWidth = pageWidth - margin * 2;

    // ── Load logo ──
    let logoBase64: string | null = null;
    if (company.logo) {
      try {
        const res = await fetch(company.logo);
        const blob = await res.blob();
        logoBase64 = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch { /* ignore */ }
    }

    let y = 12;

    // ─────────────────────────────────────────────────
    // 1. HEADER: Logo (centered) + Company details (centered)
    // ─────────────────────────────────────────────────
    const centerX = pageWidth / 2;

    if (logoBase64) {
      try {
        doc.addImage(logoBase64, 'PNG', centerX - 12.5, y, 25, 25);
      } catch { /* ignore logo errors */ }
      y += 27;
    }

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(companyName, centerX, y, { align: 'center' });
    y += 5;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    if (companyAddress) {
      doc.text(companyAddress, centerX, y, { align: 'center', maxWidth: contentWidth });
      y += 4;
    }
    if (companyPhone) {
      doc.text(`Tel: ${companyPhone}`, centerX, y, { align: 'center' });
      y += 4;
    }
    if (companyEmail) {
      doc.text(`Email: ${companyEmail}`, centerX, y, { align: 'center' });
      y += 2;
    }

    y = Math.max(y, logoBase64 ? 50 : 25);

    // ── Colored accent bar ──
    doc.setFillColor(5, 150, 105); // emerald-600
    doc.rect(margin, y, contentWidth, 2, 'F');
    y += 8;

    // ─────────────────────────────────────────────────
    // 2. TITLE: "PENAWARAN HARGA"
    // ─────────────────────────────────────────────────
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('PENAWARAN HARGA', pageWidth / 2, y, { align: 'center' });
    y += 2;

    // Decorative line under title
    const titleLineW = 70;
    doc.setDrawColor(5, 150, 105);
    doc.setLineWidth(0.8);
    doc.line(pageWidth / 2 - titleLineW / 2, y, pageWidth / 2 + titleLineW / 2, y);
    y += 8;

    // Quotation number and date
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(`No: ${quoData?.quotationNo || '-'}`, margin, y);
    doc.text(`Tanggal: ${quoData?.date || '-'}`, pageWidth - margin, y, { align: 'right' });
    y += 8;

    // ─────────────────────────────────────────────────
    // 3. PERSONALIZED GREETING
    // ─────────────────────────────────────────────────
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(`Kepada Yth. ${customer.name || '-'}`, margin, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(71, 85, 105);
    if (customer.address) {
      doc.text(customer.address, margin, y);
      y += 4.5;
    }
    if (customer.phone) {
      doc.text(`Telp: ${customer.phone}`, margin, y);
      y += 4.5;
    }
    y += 4;

    // ─────────────────────────────────────────────────
    // 4. OPENING PARAGRAPH
    // ─────────────────────────────────────────────────
    const openingLines = [
      'Dengan hormat,',
      '',
      `Melalui surat ini, kami dari ${companyName} ingin menyampaikan penawaran harga produk-produk terbaik kami kepada ${customer.name || 'Bapak/Ibu'}. Kami berkomitmen untuk memberikan produk berkualitas tinggi dengan harga yang kompetitif.`,
    ];
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 41, 59);
    openingLines.forEach((line) => {
      if (line === '') { y += 3; return; }
      const split = doc.splitTextToSize(line, contentWidth);
      doc.text(split, margin, y);
      y += split.length * 4.2;
    });
    y += 4;

    // ─────────────────────────────────────────────────
    // 5. ITEMS TABLE
    // ─────────────────────────────────────────────────
    autoTable(doc, {
      startY: y,
      head: [['No', 'Nama Produk', 'Qty', 'Satuan', 'Harga Satuan', 'Jumlah', 'Keterangan']],
      body: validItems.map((it: any, i: number) => [
        i + 1,
        it.productName,
        it.qty,
        it.unit,
        it.price.toLocaleString('id-ID'),
        (it.qty * it.price).toLocaleString('id-ID'),
        it.note || 'Harga nego',
      ]),
      foot: [['', '', '', '', 'TOTAL', total.toLocaleString('id-ID'), '']],
      styles: {
        fontSize: 8.5,
        cellPadding: 3,
        lineColor: [226, 232, 240],
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: [5, 150, 105],
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 8.5,
        cellPadding: { top: 4, bottom: 4, left: 3, right: 3 },
      },
      footStyles: {
        fillColor: [241, 245, 249],
        textColor: [15, 23, 42],
        fontStyle: 'bold',
        fontSize: 9,
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252],
      },
      columnStyles: {
        0: { halign: 'center', cellWidth: 10 },
        2: { halign: 'center', cellWidth: 14 },
        3: { halign: 'center', cellWidth: 16 },
        4: { halign: 'right', cellWidth: 28 },
        5: { halign: 'right', cellWidth: 28 },
        6: { cellWidth: 30 },
      },
      margin: { left: margin, right: margin },
    });

    y = (doc as any).lastAutoTable.finalY + 8;

    // ─────────────────────────────────────────────────
    // 6. TERMS & CONDITIONS
    // ─────────────────────────────────────────────────
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('Syarat & Ketentuan:', margin, y);
    y += 5;

    const terms = [
      'Harga belum termasuk PPN (jika applicable)',
      'Harga bersifat negotiable dan dapat berubah sewaktu-waktu',
      'Penawaran ini berlaku selama 14 (empat belas) hari kalender',
      'Pembayaran dilakukan sesuai kesepakatan kedua belah pihak',
      'Pengiriman dilakukan setelah pembayaran dikonfirmasi',
    ];
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(71, 85, 105);
    terms.forEach((term, i) => {
      doc.text(`${i + 1}. ${term}`, margin, y);
      y += 4;
    });
    y += 6;

    // ─────────────────────────────────────────────────
    // 7. CLOSING PARAGRAPH
    // ─────────────────────────────────────────────────
    const closingLines = [
      `Kami sangat mengharapkan dapat menjalin kerjasama yang baik dan saling menguntungkan dengan ${customer.name || 'Bapak/Ibu'}. Demikian surat penawaran ini kami sampaikan, atas perhatian dan kerjasamanya kami ucapkan terima kasih.`,
    ];
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 41, 59);
    closingLines.forEach((line) => {
      const split = doc.splitTextToSize(line, contentWidth);
      doc.text(split, margin, y);
      y += split.length * 4.2;
    });
    y += 10;

    // ─────────────────────────────────────────────────
    // 8. SIGNATURE AREA
    // ─────────────────────────────────────────────────
    const sigLeftX = margin;
    const sigRightX = pageWidth / 2 + 15;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(15, 23, 42);
    doc.text(companyName, sigLeftX, y);
    doc.text(customer.name || '................................', sigRightX, y);
    y += 5;

    // Signature lines (dotted)
    doc.setDrawColor(180);
    doc.setLineWidth(0.3);
    doc.setLineDashPattern([1, 1], 0);
    doc.line(sigLeftX, y + 20, sigLeftX + 60, y + 20);
    doc.line(sigRightX, y + 20, sigRightX + 60, y + 20);
    doc.setLineDashPattern([], 0);

    doc.setFontSize(9);
    doc.text('Direktur', sigLeftX, y + 24);
    doc.text('Yang bertanda tangan', sigRightX, y + 24);

    // ─────────────────────────────────────────────────
    // 9. FOOTER
    // ─────────────────────────────────────────────────
    const footerY = 282;
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(margin, footerY, pageWidth - margin, footerY);

    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    let footerInfo = companyName;
    if (companyAddress) footerInfo += ` | ${companyAddress}`;
    if (companyPhone) footerInfo += ` | ${companyPhone}`;
    doc.text(footerInfo, margin, footerY + 3.5);
    doc.text(`Dicetak pada: ${new Date().toLocaleString('id-ID')}`, pageWidth - margin, footerY + 3.5, { align: 'right' });

    doc.save(`Penawaran_${customer.name || 'Customer'}_${quoData?.quotationNo || 'QUO'}.pdf`);
    setMessages(prev => [...prev, { role: 'assistant', content: `✅ Penawaran untuk **${customer.name || quoCustomer}** berhasil dibuat!` }]);
    setShowQuotation(false);
  };

  // ============ MOU ============

  const openMouDialog = async (partnerName: string) => {
    try {
      const data = await apiFetch('/api/ai/mou', { method: 'POST', body: JSON.stringify({ partnerName, mouType: 'Distribusi', duration: '1 Tahun', scope: '' }) }) as any;
      if (data.success) {
        setMouData(data);
        setMouPartner(partnerName);
        setShowMou(true);
      }
    } catch { /* ignore */ }
  };

  const generateMouPDF = async () => {
    if (!mouPartner.trim()) { toast.error('Nama mitra wajib diisi'); return; }
    setMouGenerating(true);
    try {
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF('p', 'mm', 'a4');
      const company = mouData?.company || {};
      const mouNo = mouData?.mouNo || 'MOU-XXXXXX';
      const mouDate = mouData?.date || new Date().toLocaleDateString('id-ID');

      // Try to load logo
      let logoData: string | null = null;
      try {
        if (company.logo) {
          const res = await fetch(company.logo);
          const blob = await res.blob();
          logoData = await new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        }
      } catch { /* no logo */ }

      const pw = doc.internal.pageSize.getWidth();
      const margin = 20;
      const centerX = pw / 2;
      let y = 15;

      // HEADER: Logo (centered) + Company info (centered)
      if (logoData) {
        try { doc.addImage(logoData, 'PNG', centerX - 11, y, 22, 22); } catch { /* skip */ }
        y += 24;
      }
      doc.setFontSize(16); doc.setFont('helvetica', 'bold');
      doc.text(company.name || 'Razkindo Group', centerX, y, { align: 'center' });
      y += 5;
      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(100);
      if (company.address) { doc.text(company.address, centerX, y, { align: 'center', maxWidth: pw - margin * 2 }); y += 4; }
      if (company.phone) { doc.text(`Tel: ${company.phone}`, centerX, y, { align: 'center' }); y += 4; }
      if (company.email) { doc.text(`Email: ${company.email}`, centerX, y, { align: 'center' }); y += 2; }

      y = Math.max(y, logoData ? 50 : 35);
      doc.setDrawColor(0, 128, 100); doc.setLineWidth(0.8);
      doc.line(margin, y, pw - margin, y);

      y += 10;
      doc.setTextColor(0);
      doc.setFontSize(18); doc.setFont('helvetica', 'bold');
      doc.text('MEMORANDUM OF UNDERSTANDING', pw / 2, y, { align: 'center' });
      doc.setFontSize(10); doc.setFont('helvetica', 'italic'); doc.setTextColor(100);
      doc.text('(Nota Kesepahaman)', pw / 2, y + 6, { align: 'center' });

      y += 16;
      doc.setTextColor(0); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(`No: ${mouNo}`, margin, y);
      doc.text(`Tanggal: ${mouDate}`, pw - margin, y, { align: 'right' });

      y += 12;
      doc.setFont('helvetica', 'bold');
      doc.text(`Antara:`, margin, y);
      doc.setFont('helvetica', 'normal');
      y += 6;
      doc.text(`1. ${company.name || 'Razkindo Group'}`, margin + 5, y);
      if (company.address) { y += 5; doc.text(`   ${company.address}`, margin + 5, y); }
      y += 10;
      doc.setFont('helvetica', 'bold');
      doc.text(`Dengan:`, margin, y);
      doc.setFont('helvetica', 'normal');
      y += 6;
      doc.text(`2. ${mouPartner}`, margin + 5, y);

      y += 14;
      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(`Pasal 1 - Tujuan`, margin, y);
      y += 7;
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      const tujuanText = `Para Pihak sepakat untuk menjalin kerjasama dalam bidang ${mouType || 'distribusi produk'} dengan ketentuan-ketentuan yang diatur dalam Nota Kesepahaman ini. Kerjasama ini bertujuan untuk saling menguntungkan kedua belah pihak dan meningkatkan kualitas layanan serta jangkauan pasar.`;
      const tujuanLines = doc.splitTextToSize(tujuanText, pw - margin * 2);
      doc.text(tujuanLines, margin, y);
      y += tujuanLines.length * 5 + 8;

      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(`Pasal 2 - Ruang Lingkup`, margin, y);
      y += 7;
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      const scopeText = mouScope.trim() || `Kerjasama mencakup aktivitas ${mouType || 'distribusi'} produk-produk yang disepakati oleh kedua belah pihak. Detail spesifik mengenai jenis produk, volume, dan area distribusi akan diatur lebih lanjut dalam perjanjian terpisah.`;
      const scopeLines = doc.splitTextToSize(scopeText, pw - margin * 2);
      doc.text(scopeLines, margin, y);
      y += scopeLines.length * 5 + 8;

      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(`Pasal 3 - Jangka Waktu`, margin, y);
      y += 7;
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      const durText = `Nota Kesepahaman ini berlaku selama ${mouDuration || '1 (satu) tahun'} terhitung sejak tanggal penandatanganan. Sebelum berakhirnya jangka waktu, kedua belah pihak dapat melakukan evaluasi dan perpanjangan jika dianggap perlu.`;
      const durLines = doc.splitTextToSize(durText, pw - margin * 2);
      doc.text(durLines, margin, y);
      y += durLines.length * 5 + 8;

      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(`Pasal 4 - Hak dan Kewajiban`, margin, y);
      y += 7;
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      const hakText = `a. Pihak Pertama bertanggung jawab atas ketersediaan produk berkualitas sesuai standar yang telah disepakati.\nb. Pihak Kedua bertanggung jawab atas distribusi dan penjualan produk di wilayah yang ditentukan.\nc. Kedua belah pihak wajib menjaga kerahasiaan informasi bisnis yang diperoleh selama kerjasama.\nd. Kedua belah pihak wajib berkomunikasi secara terbuka mengenai perkembangan kerjasama.`;
      const hakLines = doc.splitTextToSize(hakText, pw - margin * 2);
      doc.text(hakLines, margin, y);
      y += hakLines.length * 5 + 8;

      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(`Pasal 5 - Pembatalan`, margin, y);
      y += 7;
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      const batalText = `Salah satu pihak dapat mengajukan pembatalan Nota Kesepahaman ini dengan pemberitahuan tertulis minimal 30 (tiga puluh) hari kalender sebelum tanggal pembatalan yang diinginkan.`;
      const batalLines = doc.splitTextToSize(batalText, pw - margin * 2);
      doc.text(batalLines, margin, y);
      y += batalLines.length * 5 + 8;

      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(`Pasal 6 - Penyelesaian Sengketa`, margin, y);
      y += 7;
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      const sengketaText = `Apabila terjadi perselisihan dalam pelaksanaan Nota Kesepahaman ini, kedua belah pihak sepakat untuk menyelesaikannya secara musyawarah untuk mufakat. Apabila musyawarah tidak menghasilkan kesepakatan, penyelesaian akan dilakukan melalui jalur hukum yang berlaku di Republik Indonesia.`;
      const sengketaLines = doc.splitTextToSize(sengketaText, pw - margin * 2);
      doc.text(sengketaLines, margin, y);
      y += sengketaLines.length * 5 + 12;

      // Closing
      doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60);
      const closingText = `Demikian Nota Kesepahaman ini dibuat dalam rangkap 2 (dua) yang masing-masing mempunyai kekuatan hukum yang sama, dan ditandatangani oleh para pihak di atas materai yang cukup.`;
      const closingLines = doc.splitTextToSize(closingText, pw - margin * 2);
      doc.text(closingLines, margin, y);
      y = Math.max(y + closingLines.length * 5 + 20, 230);

      // Signatures
      doc.setTextColor(0);
      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      const leftX = margin + 10;
      const rightX = pw - margin - 60;

      doc.text('Pihak Pertama,', leftX + 15, y);
      doc.text('Pihak Kedua,', rightX + 15, y);

      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(100);
      doc.text(company.name || 'Razkindo Group', leftX + 15, y + 5);
      doc.text(mouPartner, rightX + 15, y + 5);
      doc.setTextColor(0);

      // Signature lines
      doc.setDrawColor(0);
      doc.setLineWidth(0.3);
      doc.line(leftX, y + 30, leftX + 50, y + 30);
      doc.line(rightX, y + 30, rightX + 50, y + 30);

      doc.setFontSize(8);
      doc.text('Direktur', leftX + 15, y + 35);
      doc.text('Yang Bertanda Tangan', rightX + 15, y + 35);

      // Footer
      doc.setFontSize(7); doc.setTextColor(150);
      doc.text(`Dicetak: ${new Date().toLocaleString('id-ID')} | Dokumen ini dibuat oleh sistem Razkindo ERP`, pw / 2, 287, { align: 'center' });

      doc.save(`MOU_${mouPartner.replace(/\s+/g, '_')}_${mouNo}.pdf`);
      setMessages(prev => [...prev, { role: 'assistant', content: `✅ MOU dengan **${mouPartner}** berhasil dibuat dan didownload!` }]);
      setShowMou(false);
    } catch (err: any) {
      toast.error(err.message || 'Gagal membuat MOU');
    } finally {
      setMouGenerating(false);
    }
  };

  // ============ BROADCAST ============

  const loadBroadcastTargets = async () => {
    try {
      const data = await apiFetch<{ customers: BroadcastTarget[]; employees: BroadcastTarget[]; groups: BroadcastTarget[] }>('/api/ai/broadcast');
      setBroadcastTargets(data);
    } catch (err: any) {
      toast.error(err.message || 'Gagal memuat data broadcast');
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastMessage.trim()) { toast.error('Pesan broadcast wajib diisi'); return; }
    if (!targetAllType && selectedTargets.size === 0) { toast.error('Pilih target broadcast'); return; }

    setBroadcastLoading(true);
    setBroadcastResult(null);
    try {
      const body: any = { message: broadcastMessage.trim() };
      if (targetAllType) {
        body.targetAll = { type: targetAllType };
      } else {
        body.targets = { type: showBroadcastTargetSelect, ids: Array.from(selectedTargets) };
      }
      const data = await apiFetch<{ success: boolean; sent: number; failed: number; results: any[]; tokenInvalid?: boolean }>('/api/ai/broadcast', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (data.tokenInvalid) {
        toast.error('Token WhatsApp tidak valid. Perbarui di Settings → WhatsApp.');
      }
      setBroadcastResult({ sent: data.sent, failed: data.failed, results: data.results || [] });
      if (data.sent > 0) {
        toast.success(`${data.sent} pesan berhasil dikirim!`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Gagal mengirim broadcast');
    } finally {
      setBroadcastLoading(false);
    }
  };

  const clearChat = () => { setMessages([]); };

  // ============ AI ACTIONS ============

  const handleAiAction = async (action: string) => {
    if (action === 'discrepancy_analyze') {
      setDiscrepancyLoading(true);
      setMessages(prev => [...prev, { role: 'user', content: '🔍 Analisa semua selisih data keuangan' }]);
      try {
        const data = await apiFetch<{ success: boolean; data: any }>('/api/ai/discrepancy', {
          method: 'POST',
          body: JSON.stringify({ action: 'analyze' }),
        });
        if (data.success) {
          const d = data.data;
          const summary = d.summary;
          let reply = '🔍 **HASIL ANALISA SELISIH**\n\n';

          if (!summary.hasAnyDiscrepancy) {
            reply += '✅ **Semua data tersinkronisasi!** Tidak ada selisih yang ditemukan.\n\n';
            reply += '• Pool vs Dana Fisik: ✓ OK\n';
            reply += '• Transaksi: ✓ OK\n';
            reply += '• Pembayaran: ✓ OK\n';
          } else {
            if (summary.poolDiscrepancy) {
              const pvp = d.poolVsPhysical;
              reply += '⚠️ **Pool vs Dana Fisik:**\n';
              reply += `• Total Pool: **${formatCurrency(pvp.totalPool)}**\n`;
              reply += `• Bank: ${formatCurrency(pvp.totalBank)} + Brankas: ${formatCurrency(pvp.totalCashBox)} = **${formatCurrency(pvp.totalPhysical)}**${pvp.totalCourier > 0 ? ` (Kurir belum pool: ${formatCurrency(pvp.totalCourier)})` : ''}\n`;
              reply += `• Selisih: **${formatCurrency(Math.abs(pvp.poolPhysicalDiff))}**\n\n`;
            }
            if (summary.inconsistencyCount > 0) {
              reply += `⚠️ **${summary.inconsistencyCount} Transaksi Inkonsisten** (total ≠ paid + remaining)\n`;
              d.transactionInconsistencies.slice(0, 5).forEach((t: any) => {
                reply += `  • ${t.invoiceNo}: total ${formatCurrency(t.total)} vs ${formatCurrency(t.expectedTotal)} (selisih ${formatCurrency(Math.abs(t.discrepancy))})\n`;
              });
              reply += '\n';
            }
            if (summary.paymentMismatchCount > 0) {
              reply += `⚠️ **${summary.paymentMismatchCount} Payment Mismatch** (paid_amount ≠ sum payments)\n`;
              d.paymentMismatches.slice(0, 5).forEach((pm: any) => {
                reply += `  • ${pm.invoiceNo}: recorded ${formatCurrency(pm.transactionPaidAmount)} vs actual ${formatCurrency(pm.actualPaymentSum)} (selisih ${formatCurrency(Math.abs(pm.discrepancy))})\n`;
              });
              reply += '\n';
            }
            if (summary.receivableMismatchCount > 0) {
              reply += `⚠️ **${summary.receivableMismatchCount} Piutang Mismatch**\n\n`;
            }
            reply += '---\n💡 Gunakan **🔧 Sesuaikan Selisih** untuk auto-fix, atau **🔎 Cari Penyebab** untuk analisa akar masalah.';
          }
          setMessages(prev => [...prev, { role: 'assistant', content: reply, actionType: 'discrepancy_analyze', actionData: d }]);
        }
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal menganalisa selisih. Coba lagi.' }]);
      } finally {
        setDiscrepancyLoading(false);
      }
    } else if (action === 'discrepancy_adjust') {
      setDiscrepancyLoading(true);
      setMessages(prev => [...prev, { role: 'user', content: '🔧 Sesuaikan semua selisih data keuangan' }]);
      try {
        const data = await apiFetch<{ success: boolean; fixes: string[]; errors: string[] }>('/api/ai/discrepancy', {
          method: 'POST',
          body: JSON.stringify({ action: 'adjust' }),
        });
        if (data.success) {
          let reply = '🔧 **HASIL PENYESUAIAN SELISIH**\n\n';
          if (data.fixes.length > 0) {
            reply += '✅ **Perbaikan yang dilakukan:**\n';
            data.fixes.forEach((fix: string) => { reply += `  • ${fix}\n`; });
          }
          if (data.errors.length > 0) {
            reply += '\n❌ **Error:**\n';
            data.errors.forEach((err: string) => { reply += `  • ${err}\n`; });
          }
          if (data.fixes.length === 0 && data.errors.length === 0) {
            reply += '✅ Semua data sudah tersinkronisasi, tidak perlu penyesuaian.';
          }
          setMessages(prev => [...prev, { role: 'assistant', content: reply, actionType: 'discrepancy_adjust' }]);
        }
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal menyesuaikan selisih. Coba lagi.' }]);
      } finally {
        setDiscrepancyLoading(false);
      }
    } else if (action === 'root_cause') {
      setDiscrepancyLoading(true);
      setMessages(prev => [...prev, { role: 'user', content: '🔎 Cari akar penyebab selisih data keuangan' }]);
      try {
        const data = await apiFetch<{ success: boolean; analysis: string }>('/api/ai/discrepancy', {
          method: 'POST',
          body: JSON.stringify({ action: 'root_cause' }),
        });
        if (data.success) {
          setMessages(prev => [...prev, { role: 'assistant', content: data.analysis, actionType: 'root_cause' }]);
        }
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal menganalisis akar penyebab. Coba lagi.' }]);
      } finally {
        setDiscrepancyLoading(false);
      }
    } else if (action === 'promo_image') {
      // Load products for selection
      setMessages(prev => [...prev, { role: 'user', content: '🎨 Buat gambar promo produk' }]);
      try {
        const prodData = await apiFetch<{ products: any[] }>('/api/products?limit=20');
        const prods = (prodData.products || []).filter((p: any) => p.isActive !== false).slice(0, 15);
        setPromoProducts(prods);
        let reply = '🎨 **Buat Gambar Promo Produk**\n\nPilih produk untuk dibuatkan gambar promosi:\n\n';
        prods.forEach((p: any, i: number) => {
          reply += `${i + 1}. **${p.name}** — ${formatCurrency(p.sellingPrice)} (Stok: ${p.globalStock || 0})\n`;
        });
        reply += '\nKetik nomor produk atau nama produk, contoh: **promo semen tiga roda** atau **promo 1**';
        setMessages(prev => [...prev, { role: 'assistant', content: reply, actionType: 'promo_image', actionData: prods }]);
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal memuat daftar produk. Coba lagi.' }]);
      }
    }
  };

  // Handle promo image generation from product selection
  const generatePromoImage = async (product: any) => {
    setPromoLoading(true);
    setMessages(prev => [...prev, { role: 'user', content: `🎨 Generate gambar promo untuk ${product.name}` }]);
    try {
      const data = await apiFetch<{ success: boolean; imageUrl: string; prompt: string }>('/api/ai/promo-image', {
        method: 'POST',
        body: JSON.stringify({ productId: product.id, productName: product.name, category: product.category, sellingPrice: product.sellingPrice }),
      });
      if (data.success && data.imageUrl) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `✅ Gambar promo untuk **${product.name}** berhasil dibuat!\n\n💰 Harga: ${formatCurrency(product.sellingPrice)}\n📦 Stok: ${product.globalStock || 0}\n\nKlik gambar untuk download.`,
          imageUrl: data.imageUrl,
          actionType: 'promo_image',
        }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal generate gambar promo. Coba lagi.' }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Gagal generate gambar promo. Coba lagi.' }]);
    } finally {
      setPromoLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const renderMessageContent = (content: string, msg?: ChatMessage) => {
    return (
      <>
        {content.split('\n').map((line, i) => {
          // Safe rendering: escape HTML first, then only allow **bold** markdown
          const escaped = escapeHtml(line);
          // Split by ** markers, alternate between plain text and bold
          const parts = escaped.split(/\*\*/);
          const rendered = parts.map((part, idx) => {
            if (idx % 2 === 1) return <strong key={idx}>{part}</strong>;
            return part;
          });
          if (line.trim().startsWith('•') || line.trim().startsWith('- ')) {
            return (
              <div key={i} className="flex gap-2 ml-1">
                <span className="text-primary mt-0.5">•</span>
                <span>{rendered}</span>
              </div>
            );
          }
          return <div key={i}>{rendered.length > 0 ? rendered : '\u00A0'}</div>;
        })}
        {/* Promo image display */}
        {msg?.imageUrl && (
          <div className="mt-2">
            <img
              src={msg.imageUrl}
              alt="Promo image"
              className="w-full rounded-lg border cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => {
                const link = document.createElement('a');
                link.href = msg.imageUrl!;
                link.download = 'promo-image.png';
                link.click();
              }}
            />
            <p className="text-[10px] text-muted-foreground mt-1">Klik gambar untuk download</p>
          </div>
        )}
        {/* Promo product selection buttons */}
        {msg?.actionType === 'promo_image' && msg?.actionData && !msg?.imageUrl && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {msg.actionData.slice(0, 10).map((p: any, i: number) => (
              <button
                key={p.id}
                onClick={() => generatePromoImage(p)}
                disabled={promoLoading}
                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
              >
                🎨 {p.name?.length > 15 ? p.name.slice(0, 15) + '...' : p.name}
              </button>
            ))}
          </div>
        )}
        {/* Discrepancy action buttons */}
        {msg?.actionType === 'discrepancy_analyze' && msg?.actionData?.summary?.hasAnyDiscrepancy && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => handleAiAction('discrepancy_adjust')}
              disabled={discrepancyLoading}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors disabled:opacity-50 dark:bg-blue-900 dark:text-blue-300"
            >
              <Wrench className="w-3 h-3" /> Sesuaikan Selisih
            </button>
            <button
              onClick={() => handleAiAction('root_cause')}
              disabled={discrepancyLoading}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] rounded-full bg-red-100 text-red-700 hover:bg-red-200 transition-colors disabled:opacity-50 dark:bg-red-900 dark:text-red-300"
            >
              <AlertTriangle className="w-3 h-3" /> Cari Penyebab
            </button>
          </div>
        )}
      </>
    );
  };

  if (user?.role !== 'super_admin') return null;

  const handleTabChange = (tab: 'chat' | 'broadcast') => {
    setActiveTab(tab);
    if (tab === 'broadcast' && !broadcastTargets) loadBroadcastTargets();
  };

  return (
    <>
      {/* Floating Toggle */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "fixed bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] lg:bottom-6 right-4 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 hover:scale-110",
          isOpen
            ? "bg-red-500 hover:bg-red-600 shadow-red-500/30"
            : "bg-gradient-to-br from-emerald-500 to-teal-600 hover:shadow-emerald-500/30 shadow-emerald-500/20"
        )}
      >
        {isOpen ? <X className="w-6 h-6 text-white" /> : <Bot className="w-6 h-6 text-white" />}
        {!isOpen && <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-400 rounded-full border-2 border-background animate-pulse" />}
      </button>

      {/* Panel */}
      <div className={cn(
        "fixed z-50 transition-all duration-300 ease-out",
        "bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] lg:bottom-24 right-4",
        "w-[calc(100vw-2rem)] sm:w-[400px]",
        isOpen ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-4 pointer-events-none"
      )}>
        <div className="bg-background border shadow-2xl rounded-2xl flex flex-col overflow-hidden" style={{ height: 'min(560px, 75dvh)' }}>

          {/* Header */}
          <div className="bg-gradient-to-r from-emerald-500 to-teal-600 text-white p-3 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 bg-white/20 rounded-full flex items-center justify-center">
                  <Bot className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-sm">{isSuperAdmin ? 'Financial Analyst' : 'Asisten Data'}</p>
                  <p className="text-xs text-white/70">{isSuperAdmin ? 'AI Keuangan + Analisa + WhatsApp' : 'AI-Powered + WhatsApp'}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={clearChat} className="w-8 h-8 rounded-full hover:bg-white/20 flex items-center justify-center" title="Reset">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex mt-2 gap-1">
              <button
                onClick={() => handleTabChange('chat')}
                className={cn("flex-1 py-1.5 rounded-lg text-xs font-semibold text-center transition-colors",
                  activeTab === 'chat' ? "bg-white/25 text-white" : "text-white/70 hover:text-white hover:bg-white/10"
                )}
              >
                💬 Chat
              </button>
              <button
                onClick={() => handleTabChange('broadcast')}
                className={cn("flex-1 py-1.5 rounded-lg text-xs font-semibold text-center transition-colors",
                  activeTab === 'broadcast' ? "bg-white/25 text-white" : "text-white/70 hover:text-white hover:bg-white/10"
                )}
              >
                📢 Broadcast
              </button>
            </div>
          </div>

          {/* Tab Content */}
          {activeTab === 'chat' ? (
            <>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ scrollbarWidth: 'thin' }}>
                {messages.map((msg, idx) => (
                  <div key={idx} className={cn("flex gap-1.5", msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={cn(
                      "max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed relative group",
                      msg.role === 'user' ? "bg-primary text-primary-foreground rounded-br-md" : "bg-muted rounded-bl-md"
                    )}>
                      {msg.role === 'assistant' ? renderMessageContent(msg.content, msg) : msg.content}
                      {/* TTS play button on assistant messages */}
                      {msg.role === 'assistant' && (
                        <button
                          onClick={() => playingId === idx ? stopTTS() : handleTTS(msg.content)}
                          className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-background border shadow-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
                          title={playingId === idx ? 'Stop' : 'Putar suara'}
                        >
                          {playingId === idx ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {loading && !discrepancyLoading && !promoLoading && (
                  <div className="flex justify-start">
                    <div className="bg-muted px-4 py-2 rounded-2xl rounded-bl-md">
                      <div className="flex items-center gap-1.5">
                        <div className="flex gap-1">
                          <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                        <span className="text-xs text-muted-foreground ml-1">
                          {loadingType === 'financial' ? '📊 Mengambil & menganalisa data keuangan...' : 'Berpikir...'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                {discrepancyLoading && (
                  <div className="flex justify-start">
                    <div className="bg-amber-50 dark:bg-amber-950 px-4 py-2 rounded-2xl rounded-bl-md">
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 text-amber-600 animate-spin" />
                        <span className="text-xs text-amber-700 dark:text-amber-300 ml-1">🔍 Menganalisa selisih data keuangan...</span>
                      </div>
                    </div>
                  </div>
                )}
                {promoLoading && (
                  <div className="flex justify-start">
                    <div className="bg-purple-50 dark:bg-purple-950 px-4 py-2 rounded-2xl rounded-bl-md">
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 text-purple-600 animate-spin" />
                        <span className="text-xs text-purple-700 dark:text-purple-300 ml-1">🎨 Membuat gambar promo...</span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Quick Prompts */}
              {messages.length <= 1 && !loading && (
                <div className="px-3 pb-2 flex-shrink-0">
                  <div className="flex flex-wrap gap-1.5">
                    {quickPrompts.map((p) => (
                      <button key={p.label} onClick={() => sendMessage(p.query)}
                        className="text-[11px] px-2 py-1.5 rounded-full border bg-background hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground whitespace-nowrap">
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* AI Action Buttons */}
              {isSuperAdmin && aiActions.length > 0 && (
                <div className="px-3 pb-1.5 flex-shrink-0">
                  <div className="flex gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                    {aiActions.map((action) => (
                      <button
                        key={action.action}
                        onClick={() => handleAiAction(action.action)}
                        disabled={loading || discrepancyLoading || promoLoading}
                        className={cn(
                          "inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-medium rounded-lg border whitespace-nowrap transition-all disabled:opacity-40",
                          action.color,
                          "hover:bg-muted/50"
                        )}
                      >
                        {discrepancyLoading || promoLoading ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <action.icon className="w-3 h-3" />
                        )}
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Input */}
              <div className="p-3 border-t flex-shrink-0 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Tanya apa saja tentang data bisnis..."
                    disabled={loading}
                    className="flex-1 h-10 px-4 rounded-full border bg-muted/30 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:opacity-50 transition-all"
                  />
                  <button
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim() || loading}
                    className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-40 transition-all flex-shrink-0"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <Switch checked={ttsEnabled} onCheckedChange={setTtsEnabled} className="scale-75" />
                    <span className="text-[10px] text-muted-foreground">🔊 Auto TTS</span>
                  </label>
                  <span className="text-[10px] text-muted-foreground">Powered by Z.AI SDK</span>
                </div>
              </div>
            </>
          ) : (
            /* ===== BROADCAST TAB ===== */
            <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ scrollbarWidth: 'thin' }}>
              {!broadcastResult ? (
                <>
                  {/* Message */}
                  <div className="space-y-2">
                    <Label className="text-xs font-semibold text-muted-foreground">📢 Pesan Broadcast</Label>
                    <Textarea
                      value={broadcastMessage}
                      onChange={(e) => setBroadcastMessage(e.target.value)}
                      placeholder="Tulis pesan promo atau pengumuman...\n\nContoh:\n🛍️ PROMO SPESIAL!\nDiskon 20% untuk semua produk.\nBerlaku sampai akhir bulan!\n\nHubungi kami sekarang!"
                      className="text-sm min-h-[100px] resize-none"
                    />
                  </div>

                  {/* Target Type Selector */}
                  <div className="space-y-2">
                    <Label className="text-xs font-semibold text-muted-foreground">🎯 Kirim ke</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => { setTargetAllType('all_customers'); setSelectedTargets(new Set()); setShowBroadcastTargetSelect(false); }}
                        className={cn("p-2.5 rounded-xl border-2 text-center transition-all",
                          targetAllType === 'all_customers' ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20" : "border-border hover:border-emerald-300"
                        )}
                      >
                        <Users className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                        <p className="text-xs font-semibold">Semua Pelanggan</p>
                      </button>
                      <button
                        onClick={() => { setTargetAllType('all_employees'); setSelectedTargets(new Set()); setShowBroadcastTargetSelect(false); }}
                        className={cn("p-2.5 rounded-xl border-2 text-center transition-all",
                          targetAllType === 'all_employees' ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-border hover:border-blue-300"
                        )}
                      >
                        <Users className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                        <p className="text-xs font-semibold">Semua Karyawan</p>
                      </button>
                    </div>

                    {/* Individual selection (optional) */}
                    <button
                      onClick={() => setShowBroadcastTargetSelect(!showBroadcastTargetSelect)}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl border text-xs hover:bg-muted/50 transition-colors"
                    >
                      <span className="font-medium">Pilih manual...</span>
                      {showBroadcastTargetSelect ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>

                    {showBroadcastTargetSelect && broadcastTargets && (
                      <div className="space-y-2 max-h-40 overflow-y-auto border rounded-xl p-2">
                        {/* Target type sub-tabs */}
                        <div className="flex gap-1">
                          {(['customers', 'employees', 'groups'] as const).map(t => (
                            <button key={t} onClick={() => setShowBroadcastTargetSelect(true)}
                              className={cn("text-[10px] px-2 py-1 rounded-md font-medium",
                                showBroadcastTargetSelect ? "bg-primary/10 text-primary" : "text-muted-foreground"
                              )}>
                              {t === 'customers' ? '👥 Pelanggan' : t === 'employees' ? '👔 Karyawan' : '📱 Grup WA'}
                            </button>
                          ))}
                        </div>
                        {/* Customer list */}
                        <div className="space-y-0.5">
                          <p className="text-[10px] font-semibold text-muted-foreground px-1 mb-1">👥 Pelanggan ({broadcastTargets.customers.length})</p>
                          {broadcastTargets.customers.slice(0, 10).map(c => (
                            <label key={c.id} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted/50 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={selectedTargets.has(c.id)}
                                onChange={e => {
                                  setTargetAllType(null);
                                  setSelectedTargets(prev => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(c.id); else next.delete(c.id);
                                    return next;
                                  });
                                }}
                                className="rounded"
                              />
                              <span className="truncate flex-1">{c.name}</span>
                              <span className="text-muted-foreground">{c.phone || '-'}</span>
                            </label>
                          ))}
                          {broadcastTargets.customers.length > 10 && (
                            <p className="text-[10px] text-muted-foreground text-center">+{broadcastTargets.customers.length - 10} lainnya...</p>
                          )}
                        </div>
                        {/* Employee list */}
                        <div className="space-y-0.5 mt-2">
                          <p className="text-[10px] font-semibold text-muted-foreground px-1 mb-1">👔 Karyawan ({broadcastTargets.employees.length})</p>
                          {broadcastTargets.employees.slice(0, 10).map(e => (
                            <label key={e.id} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted/50 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={selectedTargets.has(e.id)}
                                onChange={ev => {
                                  setTargetAllType(null);
                                  setSelectedTargets(prev => {
                                    const next = new Set(prev);
                                    if (ev.target.checked) next.add(e.id); else next.delete(e.id);
                                    return next;
                                  });
                                }}
                                className="rounded"
                              />
                              <span className="truncate flex-1">{e.name}</span>
                              <span className="text-muted-foreground">{e.phone || '-'}</span>
                            </label>
                          ))}
                        </div>
                        {/* Groups */}
                        {broadcastTargets.groups.length > 0 && (
                          <div className="space-y-0.5 mt-2">
                            <p className="text-[10px] font-semibold text-muted-foreground px-1 mb-1">📱 Grup WA ({broadcastTargets.groups.length})</p>
                            {broadcastTargets.groups.map(g => (
                              <label key={g.id} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted/50 cursor-pointer text-xs">
                                <input
                                  type="checkbox"
                                  checked={selectedTargets.has(g.id || g.jid || '')}
                                  onChange={ev => {
                                    setTargetAllType(null);
                                    setSelectedTargets(prev => {
                                      const next = new Set(prev);
                                      if (ev.target.checked) next.add(g.id || g.jid || ''); else next.delete(g.id || g.jid || '');
                                      return next;
                                    });
                                  }}
                                  className="rounded"
                                />
                                <span className="truncate flex-1">{g.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Selected count & Send */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Target: <strong className="text-foreground">
                          {targetAllType === 'all_customers' ? `${broadcastTargets?.customers.length || 0} pelanggan`
                            : targetAllType === 'all_employees' ? `${broadcastTargets?.employees.length || 0} karyawan`
                            : `${selectedTargets.size} dipilih`}
                        </strong>
                      </span>
                    </div>
                    <Button
                      onClick={handleBroadcast}
                      disabled={broadcastLoading || !broadcastMessage.trim() || (!targetAllType && selectedTargets.size === 0)}
                      className="w-full bg-green-600 hover:bg-green-700 h-11 gap-2"
                    >
                      {broadcastLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
                      {broadcastLoading ? 'Mengirim...' : `Kirim Broadcast`}
                    </Button>
                  </div>
                </>
              ) : (
                /* Result */
                <div className="space-y-3">
                  <div className="text-center p-4 rounded-xl bg-muted/50">
                    <Megaphone className="w-10 h-10 mx-auto mb-2 text-green-600" />
                    <p className="font-semibold text-sm">Broadcast Selesai!</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 text-center">
                      <CheckCircle2 className="w-6 h-6 mx-auto mb-1 text-green-600" />
                      <p className="text-lg font-bold text-green-700">{broadcastResult.sent}</p>
                      <p className="text-[10px] text-green-600">Terkirim</p>
                    </div>
                    <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 text-center">
                      <XCircle className="w-6 h-6 mx-auto mb-1 text-red-500" />
                      <p className="text-lg font-bold text-red-600">{broadcastResult.failed}</p>
                      <p className="text-[10px] text-red-500">Gagal</p>
                    </div>
                  </div>

                  {broadcastResult.results.slice(0, 5).map((r: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs p-2 rounded-lg bg-muted/30">
                      {r.success ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                      <span className="truncate flex-1">{r.target}</span>
                      {r.error && <span className="text-red-500 truncate max-w-[120px]">{r.error}</span>}
                    </div>
                  ))}

                  <Button variant="outline" onClick={() => setBroadcastResult(null)} className="w-full">
                    Kirim Lagi
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Quotation Dialog */}
      {showQuotation && quoData && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowQuotation(false)}>
          <div className="bg-background rounded-2xl w-full max-w-lg max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <h3 className="font-semibold text-lg">📝 Buat Penawaran</h3>
              <button onClick={() => setShowQuotation(false)} className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <Label className="text-sm font-medium">Konsumen</Label>
                <Input value={quoCustomer} onChange={e => setQuoCustomer(e.target.value)} placeholder="Nama konsumen..." className="mt-1" />
                {quoData.customer && <p className="text-xs text-muted-foreground mt-1">📱 {quoData.customer.phone} | 📍 {quoData.customer.address || '-'}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-sm font-medium">No. Penawaran</Label>
                  <Input value={quoData.quotationNo} readOnly className="mt-1 bg-muted/50" />
                </div>
                <div>
                  <Label className="text-sm font-medium">Tanggal</Label>
                  <Input value={quoData.date} readOnly className="mt-1 bg-muted/50" />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-medium">Produk</Label>
                  <Button size="sm" variant="outline" onClick={() => setQuoItems(prev => [...prev, { productId: '', productName: '', qty: 0, unit: 'pcs', price: 0, note: 'Harga nego' }])} className="h-7 text-xs"><Plus className="w-3 h-3 mr-1" /> Tambah</Button>
                </div>
                <div className="space-y-2">
                  {quoItems.map((item: any, idx: number) => (
                    <div key={idx} className="p-3 border rounded-lg space-y-2 bg-muted/20">
                      <div className="flex items-start gap-2">
                        <select className="flex-1 h-9 rounded-md border bg-background px-2 text-sm" value={item.productId} onChange={e => {
                          const prod = quoData?.products?.find((p: any) => p.id === e.target.value);
                          setQuoItems(prev => prev.map((it, i) => i !== idx ? it : { ...it, productId: e.target.value, productName: prod?.name || '', unit: prod?.unit || 'pcs', price: prod?.price || 0 }));
                        }}>
                          <option value="">Pilih produk...</option>
                          {quoData.products?.map((p: any) => <option key={p.id} value={p.id}>{p.name} — {p.price?.toLocaleString('id-ID')}</option>)}
                        </select>
                        {quoItems.length > 1 && <button onClick={() => setQuoItems(prev => prev.filter((_, i) => i !== idx))} className="text-red-500 hover:text-red-700 p-1"><Trash2 className="w-4 h-4" /></button>}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <Label className="text-xs text-muted-foreground">Qty</Label>
                          <Input type="number" min="0" className="h-8 text-sm" value={item.qty || ''} onChange={e => setQuoItems(prev => prev.map((it, i) => i !== idx ? it : { ...it, qty: parseInt(e.target.value) || 0 }))} />
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Harga</Label>
                          <Input type="number" min="0" className="h-8 text-sm" value={item.price || ''} onChange={e => setQuoItems(prev => prev.map((it, i) => i !== idx ? it : { ...it, price: parseInt(e.target.value) || 0 }))} />
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Total</Label>
                          <div className="h-8 flex items-center text-sm font-medium">{formatCurrency((item.qty || 0) * (item.price || 0))}</div>
                        </div>
                      </div>
                      <Input placeholder="Catatan" className="h-8 text-xs" value={item.note || ''} onChange={e => setQuoItems(prev => prev.map((it, i) => i !== idx ? it : { ...it, note: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="p-3 bg-primary/5 rounded-lg border">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Total</span>
                  <span className="text-lg font-bold text-primary">{formatCurrency(quoItems.reduce((s: number, it: any) => s + ((it.qty || 0) * (it.price || 0)), 0))}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setShowQuotation(false)} className="flex-1">Batal</Button>
                <Button onClick={generateQuotationPDF} disabled={quoItems.filter(it => it.productName && it.qty > 0).length === 0} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                  <Download className="w-4 h-4 mr-2" /> Download PDF
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MOU Dialog */}
      {showMou && mouData && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowMou(false)}>
          <div className="bg-background rounded-2xl w-full max-w-lg max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <h3 className="font-semibold text-lg">📄 Buat MOU</h3>
              <button onClick={() => setShowMou(false)} className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <Label className="text-sm font-medium">Nama Mitra / Pihak Kedua</Label>
                <Input value={mouPartner} onChange={e => setMouPartner(e.target.value)} placeholder="Nama perusahaan atau individu..." className="mt-1" />
                {mouData.partner && <p className="text-xs text-muted-foreground mt-1">📱 {mouData.partner.phone} | 📍 {mouData.partner.address || '-'}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-sm font-medium">No. MOU</Label>
                  <Input value={mouData.mouNo} readOnly className="mt-1 bg-muted/50" />
                </div>
                <div>
                  <Label className="text-sm font-medium">Tanggal</Label>
                  <Input value={mouData.date} readOnly className="mt-1 bg-muted/50" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-sm font-medium">Jenis Kerjasama</Label>
                  <select
                    className="flex-1 h-9 w-full rounded-md border bg-background px-3 text-sm mt-1"
                    value={mouType}
                    onChange={e => setMouType(e.target.value)}
                  >
                    <option value="Distribusi">Distribusi</option>
                    <option value="Suplai">Suplai</option>
                    <option value="Jasa">Jasa</option>
                    <option value="Layanan">Layanan</option>
                    <option value="Kerjasama Umum">Kerjasama Umum</option>
                  </select>
                </div>
                <div>
                  <Label className="text-sm font-medium">Durasi</Label>
                  <select
                    className="flex-1 h-9 w-full rounded-md border bg-background px-3 text-sm mt-1"
                    value={mouDuration}
                    onChange={e => setMouDuration(e.target.value)}
                  >
                    <option value="6 Bulan">6 Bulan</option>
                    <option value="1 Tahun">1 Tahun</option>
                    <option value="2 Tahun">2 Tahun</option>
                    <option value="3 Tahun">3 Tahun</option>
                    <option value="5 Tahun">5 Tahun</option>
                  </select>
                </div>
              </div>
              <div>
                <Label className="text-sm font-medium">Ruang Lingkup <span className="text-xs text-muted-foreground font-normal">(opsional)</span></Label>
                <Textarea
                  value={mouScope}
                  onChange={e => setMouScope(e.target.value)}
                  placeholder="Deskripsi detail ruang lingkup kerjasama..."
                  className="mt-1 text-sm min-h-[80px] resize-none"
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setShowMou(false)} className="flex-1">Batal</Button>
                <Button onClick={generateMouPDF} disabled={mouGenerating || !mouPartner.trim()} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
                  {mouGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                  {mouGenerating ? 'Membuat...' : 'Download PDF'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
