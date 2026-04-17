import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { format } from 'date-fns';
import { id } from 'date-fns/locale';
import { verifyAuthUser } from '@/lib/token';
import { rowsToCamelCase, toCamelCase } from '@/lib/supabase-helpers';

function rp(n: number) {
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

function dateRange(period: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (period) {
    case 'hari': case 'today': case 'hari ini':
      return today.toISOString();
    case 'minggu': case 'week': case 'minggu ini': {
      const day = today.getDay();
      const start = new Date(today);
      start.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
      return start.toISOString();
    }
    case 'bulan': case 'month': case 'bulan ini':
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    default:
      return undefined;
  }
}

// ============ DATA QUERY FUNCTIONS ============

async function handleSalesToday(isSuperAdmin: boolean) {
  const dr = dateRange('hari ini');
  let query = db.from('transactions').select(`
    *, items:transaction_items(*), created_by:users!created_by_id(name, role), customer:customers(name)
  `).eq('type', 'sale').in('status', ['approved', 'paid']);
  if (dr) query = query.gte('transaction_date', dr);
  const { data: sales } = await query.order('transaction_date', { ascending: false }).limit(50);
  const list = sales || [];
  const total = list.reduce((s, t: any) => s + (t.total || 0), 0);
  const paid = list.reduce((s, t: any) => s + (t.paid_amount || 0), 0);

  let text = `📊 **Penjualan Hari Ini**\n`;
  text += `📅 ${format(new Date(), 'EEEE, dd MMMM yyyy', { locale: id })}\n\n`;
  text += `💰 Total: **${rp(total)}**\n`;
  if (isSuperAdmin) {
    const profit = list.reduce((s, t: any) => s + (t.total_profit || 0), 0);
    text += `📈 Profit: **${rp(profit)}**\n`;
  }
  text += `💵 Dibayar: **${rp(paid)}**\n`;
  text += `📝 Transaksi: **${list.length}**\n`;
  if (list.length > 0) {
    text += `\n---\n📝 **Detail:**\n`;
    list.slice(0, 10).forEach((t: any, i: number) => {
      const c = t.customer?.name || 'Umum';
      const ps = t.payment_status === 'paid' ? '✅' : '⏳';
      text += `\n${i + 1}. **${t.invoice_no}** — ${c} | ${rp(t.total)} | ${ps}\n`;
    });
  } else {
    text += `\n_Belum ada transaksi hari ini._`;
  }
  return text;
}

async function handleSalesWeek(isSuperAdmin: boolean) {
  const dr = dateRange('minggu ini');
  let query = db.from('transactions').select('total, total_profit').eq('type', 'sale').in('status', ['approved', 'paid']);
  if (dr) query = query.gte('transaction_date', dr);
  const { data: sales } = await query;
  const list = sales || [];
  const total = list.reduce((s, t: any) => s + (t.total || 0), 0);
  const profit = list.reduce((s, t: any) => s + (t.total_profit || 0), 0);

  let text = `📊 **Penjualan Minggu Ini**\n\n`;
  text += `💰 Total: **${rp(total)}**\n`;
  if (isSuperAdmin) text += `📈 Profit: **${rp(profit)}**\n`;
  text += `📝 Transaksi: **${list.length}**\n`;
  return text;
}

async function handleSalesMonth(isSuperAdmin: boolean) {
  const dr = dateRange('bulan ini');
  let query = db.from('transactions').select('total, total_profit').eq('type', 'sale').in('status', ['approved', 'paid']);
  if (dr) query = query.gte('transaction_date', dr);
  const { data: sales } = await query;
  const list = sales || [];
  const total = list.reduce((s, t: any) => s + (t.total || 0), 0);
  const profit = list.reduce((s, t: any) => s + (t.total_profit || 0), 0);

  let text = `📊 **Penjualan Bulan Ini**\n`;
  text += `📅 ${format(new Date(), 'MMMM yyyy', { locale: id })}\n\n`;
  text += `💰 Total: **${rp(total)}**\n`;
  if (isSuperAdmin) {
    text += `📈 Profit: **${rp(profit)}**\n`;
    text += `📊 Margin: **${total > 0 ? ((profit / total) * 100).toFixed(1) : 0}%**\n`;
  }
  text += `📝 Transaksi: **${list.length}**\n`;
  return text;
}

async function handleSalesPerSales(isSuperAdmin: boolean) {
  const { data: sales } = await db.from('transactions').select(`
    *, created_by:users!created_by_id(name, role)
  `).eq('type', 'sale').in('status', ['approved', 'paid']).order('transaction_date', { ascending: false }).limit(500);

  const bySales = new Map<string, { name: string; total: number; count: number; profit: number }>();
  (sales || []).forEach((t: any) => {
    const cb = t.created_by;
    if (cb?.role === 'sales') {
      const e = bySales.get(t.created_by_id) || { name: cb.name, total: 0, count: 0, profit: 0 };
      e.total += (t.total || 0);
      e.count += 1;
      e.profit += (t.total_profit || 0);
      bySales.set(t.created_by_id, e);
    }
  });
  const ranked = Array.from(bySales.values()).sort((a, b) => b.total - a.total);
  let text = `👥 **Penjualan Per Sales**\n\n`;
  if (ranked.length === 0) return text + '_Tidak ada data._';
  ranked.forEach((s, i) => {
    text += `${i + 1}. **${s.name}**\n`;
    text += `   💰 ${rp(s.total)} | 📝 ${s.count} trx`;
    if (isSuperAdmin) text += ` | 📈 ${rp(s.profit)}`;
    text += `\n\n`;
  });
  return text;
}

async function handleStockAll(isSuperAdmin: boolean) {
  const { data: products } = await db.from('products').select('*').eq('is_active', true).order('name').limit(100);
  const list = products || [];
  let text = `📦 **Stok Produk**\n`;
  text += `📋 Total: **${list.length} produk**\n\n`;
  list.forEach((p: any) => {
    const status = p.global_stock === 0 ? '🚫' : p.global_stock <= p.min_stock ? '⚠️' : '✅';
    text += `${status} **${p.name}** — Stok: ${p.global_stock} ${p.unit || 'pcs'} | Jual: ${rp(p.selling_price)}\n`;
  });
  return text;
}

async function handleStockLow() {
  const { data: products } = await db.from('products').select('*').eq('is_active', true).gt('global_stock', 0).limit(500);
  const low = (products || []).filter((p: any) => p.global_stock > 0 && p.global_stock <= (p.min_stock || 0));
  let text = `⚠️ **Stok Rendah**\n\n`;
  if (low.length === 0) return text + '_Semua stok aman!_ ✅\n';
  low.forEach((p: any) => text += `⚠️ **${p.name}** — Stok: **${p.global_stock}** (Min: ${p.min_stock})\n`);
  return text;
}

async function handleCustomersUnpaid() {
  const { data: receivables } = await db.from('receivables').select('*').eq('status', 'active').order('remaining_amount', { ascending: false }).limit(100);
  let text = `📋 **Piutang Aktif**\n`;
  text += `📋 Total: **${(receivables || []).length} piutang**\n\n`;
  if ((receivables || []).length === 0) return text + '_Semua lunas!_ ✅\n';
  (receivables || []).forEach((r: any, i: number) => {
    const overdue = r.overdue_days > 0 ? `🔴 ${r.overdue_days} hari` : '🟢';
    text += `${i + 1}. **${r.customer_name || '-'}** — ${rp(r.remaining_amount)} / ${rp(r.total_amount)} | ${overdue}\n\n`;
  });
  return text;
}

async function handleCustomersSummary() {
  const { count: total } = await db.from('customers').select('*', { count: 'exact', head: true });
  const { data: topCustomers } = await db.from('customers').select('*').order('total_spent', { ascending: false }).limit(10);
  const totalSpent = (topCustomers || []).reduce((s: number, c: any) => s + (c.total_spent || 0), 0);
  let text = `👥 **Konsumen**\n\n`;
  text += `📋 Total: **${total}**\n💰 Total Belanja: **${rp(totalSpent)}**\n\n🏆 **Top:**\n`;
  (topCustomers || []).forEach((c: any, i: number) => {
    text += `${i + 1}. **${c.name}** — ${rp(c.total_spent || 0)} (${c.total_orders || 0} order)\n`;
  });
  return text;
}

// ============ FINANCIAL SNAPSHOT DATA FETCHER ============

/**
 * Fetch comprehensive financial data by calling the financial-snapshot endpoint internally.
 * This gives the LLM access to ALL financial data for deep analysis.
 */
async function fetchFinancialSnapshot(authHeader: string | null, origin: string): Promise<any | null> {
  try {
    const url = `${origin}/api/ai/financial-snapshot`;
    const res = await fetch(url, {
      headers: {
        'Authorization': authHeader || '',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000), // 15s timeout
    });
    if (!res.ok) {
      console.error('[AI Chat] Financial snapshot fetch failed:', res.status);
      return null;
    }
    const json = await res.json();
    return json.data || null;
  } catch (err) {
    console.error('[AI Chat] Financial snapshot fetch error:', err);
    return null;
  }
}

// ============ AUDIT DATA FETCHER ============

/**
 * Fetch deep audit data by calling the audit endpoint internally.
 * Returns comprehensive discrepancy analysis for the LLM.
 */
async function fetchAuditData(authHeader: string | null, origin: string): Promise<any | null> {
  try {
    const url = `${origin}/api/ai/audit`;
    const res = await fetch(url, {
      headers: {
        'Authorization': authHeader || '',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000), // 30s timeout for deep audit
    });
    if (!res.ok) {
      console.error('[AI Chat] Audit fetch failed:', res.status);
      return null;
    }
    const json = await res.json();
    return json.data || null;
  } catch (err) {
    console.error('[AI Chat] Audit fetch error:', err);
    return null;
  }
}

/**
 * Build structured audit context string from audit data for LLM consumption.
 */
function buildAuditContext(data: any): string {
  if (!data) return '';

  const lines: string[] = [];
  lines.push('=== HASIL AUDIT KEUANGAN RAZKINDO (Deep Audit) ===');
  lines.push('');

  const summary = data.summary;
  if (summary) {
    lines.push(`Waktu Audit: ${summary.auditTimestamp}`);
    lines.push(`Total Transaksi: ${summary.totalTransactions}`);
    lines.push(`Total Piutang: ${summary.totalReceivables} (${summary.activeReceivables} aktif)`);
    lines.push(`Status Keseluruhan: ${summary.overallStatus === 'healthy' ? '✅ SEHAT' : summary.overallStatus === 'critical' ? '🔴 KRITIS' : '⚠️ PERINGATAN'}`);
    lines.push(`🔍 ${summary.criticalCount} masalah kritis, ${summary.warningCount} peringatan, ${summary.infoCount} info`);
    lines.push('');

    lines.push('--- HASIL CHECK ---');
    if (summary.checks) {
      const checks = summary.checks;
      lines.push(`1. Konsistensi Transaksi: ${checks.transactionConsistency.status} (${checks.transactionConsistency.issues} masalah dari ${checks.transactionConsistency.checked} transaksi)`);
      lines.push(`2. Verifikasi Pembayaran: ${checks.paymentVerification.status} (${checks.paymentVerification.issues} mismatch dari ${checks.paymentVerification.checked} transaksi)`);
      lines.push(`3. Sinkronisasi Piutang: ${checks.receivableSync.status}`);
      lines.push(`4. Pool Balance: ${checks.poolBalance.status}`);
      lines.push(`5. Saldo Rekening: ${checks.accountBalances.status} (Bank: ${rp(checks.accountBalances.totalBank)}, Brankas: ${rp(checks.accountBalances.totalCashBox)}, Kurir: ${rp(checks.accountBalances.totalCourier)})`);
      lines.push(`6. Integritas HPP/Profit: ${checks.hppProfitIntegrity.status}`);
    }
    lines.push('');
  }

  // Critical issues
  if (data.discrepancies?.critical?.length > 0) {
    lines.push('--- 🔴 MASALAH KRITIS ---');
    data.discrepancies.critical.slice(0, 15).forEach((d: any) => {
      lines.push(`[${d.type}] ${d.invoiceNo || d.accountName || d.description}`);
      if (d.currentValue) lines.push(`  Saat ini: ${JSON.stringify(d.currentValue)}`);
      if (d.expectedValue) lines.push(`  Seharusnya: ${JSON.stringify(d.expectedValue)}`);
      if (d.discrepancy !== null && d.discrepancy !== undefined) lines.push(`  Selisih: ${rp(Math.abs(d.discrepancy))}`);
      if (d.suggestedFix) {
        lines.push(`  Saran Fix: ${d.suggestedFix.field} → ${d.suggestedFix.correctValue} (${d.suggestedFix.reason})`);
      }
      lines.push('');
    });
  }

  // Warnings
  if (data.discrepancies?.warning?.length > 0) {
    lines.push('--- ⚠️ PERINGATAN ---');
    data.discrepancies.warning.slice(0, 10).forEach((d: any) => {
      lines.push(`[${d.type}] ${d.invoiceNo || d.customerName || d.description}`);
      if (d.discrepancy !== null && d.discrepancy !== undefined) lines.push(`  Selisih: ${rp(Math.abs(d.discrepancy))}`);
      if (d.suggestedFix) {
        lines.push(`  Saran Fix: ${d.suggestedFix.field} → ${d.suggestedFix.correctValue}`);
      }
    });
    lines.push('');
  }

  lines.push('=== AKHIR DATA AUDIT ===');
  return lines.join('\n');
}

/**
 * Build a structured financial context string from snapshot data for LLM consumption.
 */
function buildFinancialContext(data: any): string {
  if (!data) return '';

  const lines: string[] = [];
  lines.push('=== DATA KEUANGAN RAZKINDO (Real-time Snapshot) ===');
  lines.push('');

  // 1. Cash Pools (HPP & Profit accumulation)
  if (data.cashPools) {
    const cp = data.cashPools;
    lines.push('--- 1. POOL DANA ---');
    lines.push(`HPP sudah dikembalikan (di tangan): ${rp(cp.hppInHand)}`);
    lines.push(`Profit sudah di tangan: ${rp(cp.profitInHand)}`);
    lines.push(`HPP masih tertahan (belum dibayar pelanggan): ${rp(cp.hppUnpaid)}`);
    lines.push(`Profit tertahan (belum dibayar pelanggan): ${rp(cp.profitUnpaid)}`);
    lines.push(`Total penjualan keseluruhan: ${rp(cp.totalSales)} (${cp.totalTransactions} transaksi)`);
    lines.push(`Total uang masuk (dibayar): ${rp(cp.totalPaid)}`);
    lines.push(`Total piutang tersisa: ${rp(cp.totalReceivables)}`);
    lines.push(`Total HPP keseluruhan: ${rp(cp.totalHpp)}`);
    lines.push(`Total Profit keseluruhan: ${rp(cp.totalProfit)}`);
    lines.push('');
  }

  // 2. Account Balances
  if (data.accountBalances) {
    const ab = data.accountBalances;
    lines.push('--- 2. SALDO REKENING ---');
    if (ab.bankAccounts?.length > 0) {
      ab.bankAccounts.forEach((b: any) => {
        if (b.isActive) lines.push(`Bank ${b.bankName} (${b.name}): ${rp(b.balance)}`);
      });
    }
    if (ab.cashBoxes?.length > 0) {
      ab.cashBoxes.forEach((cb: any) => {
        const unit = cb.unit?.name || '';
        lines.push(`Brankas ${cb.name}${unit ? ` [${unit}]` : ''}: ${rp(cb.balance)}`);
      });
    }
    lines.push(`Total saldo semua rekening: ${rp(ab.totalBalance)}`);
    lines.push('');
  }

  // 3. Sales Trend (4 months)
  if (data.salesTrend?.length > 0) {
    lines.push('--- 3. TREN PENJUALAN (4 Bulan Terakhir) ---');
    data.salesTrend.forEach((m: any) => {
      const growthIcon = m.salesGrowthPct === null ? '' : m.salesGrowthPct >= 0 ? '▲' : '▼';
      const growthStr = m.salesGrowthPct !== null ? ` (${growthIcon}${Math.abs(m.salesGrowthPct)}%)` : '';
      lines.push(`${m.month}: Sales ${rp(m.totalSales)}, Profit ${rp(m.totalProfit)}, ${m.txCount} trx, Avg ${rp(m.avgOrderValue)}/order${growthStr}`);
    });
    lines.push('');
  }

  // 4. Top Products (90 days)
  if (data.topProducts?.length > 0) {
    lines.push('--- 4. PRODUK TERLARIS (90 Hari Terakhir) ---');
    data.topProducts.forEach((p: any, i: number) => {
      lines.push(`${i + 1}. ${p.productName}: Revenue ${rp(p.totalRevenue)}, ${p.totalQty} qty, velocity ${p.velocity}/hari, avg ${rp(p.avgRevenuePerOrder)}/trx`);
    });
    lines.push('');
  }

  // 5. Customer Purchase Patterns
  if (data.customerPatterns?.length > 0) {
    lines.push('--- 5. POLA PEMBELIAN KONSUMEN (180 Hari) ---');
    data.customerPatterns.slice(0, 15).forEach((c: any) => {
      const overdue = c.isOverdue ? ' ⚠️ OVERDUE' : '';
      const nextOrder = c.predictedNextOrder
        ? `Prediksi order berikutnya: ${format(new Date(c.predictedNextOrder), 'dd MMM yyyy', { locale: id })}`
        : 'Prediksi: tidak cukup data';
      const typical = c.typicalProducts?.length > 0
        ? `Produk biasa: ${c.typicalProducts.map((tp: any) => `${tp.productName}(x${tp.frequency})`).join(', ')}`
        : '';
      lines.push(`${c.customerName}: ${c.totalOrders} order, total ${rp(c.totalSpent)}, avg ${rp(c.avgOrderValue)}/order, rata-rata setiap ${c.avgDaysBetweenOrders} hari${overdue}`);
      if (typical) lines.push(`  → ${typical}`);
      lines.push(`  → ${nextOrder}`);
    });
    lines.push('');
  }

  // 6. Purchase Recommendations
  if (data.purchaseRecommendations?.length > 0) {
    lines.push('--- 6. REKOMENDASI RESTOCK ---');
    data.purchaseRecommendations.forEach((r: any) => {
      lines.push(`${r.productName}: stok ${r.currentStock} ${r.unit}, velocity ${r.velocity}/hari, sisa ${r.daysOfStock} hari → Saran beli ${r.suggestedQty} ${r.unit}, est. biaya ${rp(r.estimatedCost)} (HPP ${rp(r.avgHpp)}/${r.unit})`);
    });
    lines.push('');
  } else {
    lines.push('--- 6. REKOMENDASI RESTOCK: Stok semua produk masih mencukupi ---');
    lines.push('');
  }

  // 7. Discrepancies
  if (data.discrepancies) {
    const d = data.discrepancies;
    lines.push('--- 7. DETEKSI SELISIH & MASALAH ---');
    lines.push(`Transaksi belum lunas: ${d.unpaidCount} (total piutang ${rp(d.totalUnpaidReceivables)})`);
    lines.push(`Inkonsistensi data (total ≠ paid + remaining): ${d.inconsistencyCount} transaksi`);
    lines.push(`Payment mismatch (paid_amount ≠ sum payments): ${d.paymentMismatchCount} transaksi`);
    if (d.dataInconsistencies?.length > 0) {
      lines.push('Detail inkonsistensi:');
      d.dataInconsistencies.slice(0, 5).forEach((inc: any) => {
        lines.push(`  ${inc.invoiceNo}: total ${rp(inc.total)} vs paid+remaining ${rp(inc.expectedTotal)} (selisih ${rp(Math.abs(inc.discrepancy))})`);
      });
    }
    if (d.paymentMismatches?.length > 0) {
      lines.push('Detail payment mismatch:');
      d.paymentMismatches.slice(0, 5).forEach((pm: any) => {
        lines.push(`  ${pm.invoiceNo}: paid_amount ${rp(pm.transactionPaidAmount)} vs actual payments ${rp(pm.actualPaymentSum)} (selisih ${rp(Math.abs(pm.discrepancy))})`);
      });
    }
    lines.push('');
  }

  // 8. Cash Flow
  if (data.cashFlowSummary) {
    const cf = data.cashFlowSummary;
    lines.push('--- 8. ARUS KAS ---');
    lines.push(`7 hari terakhir: Uang masuk ${rp(cf.last7Days.inflow)}, Uang keluar ${rp(cf.last7Days.outflow)}, Bersih ${rp(cf.last7Days.net)}`);
    lines.push(`30 hari terakhir: Uang masuk ${rp(cf.last30Days.inflow)}, Uang keluar ${rp(cf.last30Days.outflow)}, Bersih ${rp(cf.last30Days.net)}`);
    lines.push('');
  }

  // 9. Company Debts
  if (data.companyDebts) {
    const cd = data.companyDebts;
    lines.push('--- 9. HUTANG PERUSAHAAN ---');
    lines.push(`Total hutang tersisa: ${rp(cd.totalDebtRemaining)} (${cd.totalDebtCount} hutang)`);
    lines.push(`Hutang overdue: ${cd.overdueDebtCount} (total ${rp(cd.totalOverdueAmount)})`);
    if (cd.debts?.length > 0) {
      cd.debts.slice(0, 8).forEach((d: any) => {
        const status = d.isOverdue ? '🔴 OVERDUE' : d.status || '';
        const daysInfo = d.daysUntilDue !== null ? (d.isOverdue ? ` (terlambat ${Math.abs(d.daysUntilDue)} hari)` : ` (${d.daysUntilDue} hari lagi)`) : '';
        lines.push(`  ${d.creditorName}: ${rp(d.remainingAmount)} / ${rp(d.totalAmount)} [${d.debtType}]${daysInfo} ${status}`);
      });
    }
    lines.push('');
  }

  // 10. Product Asset Value
  if (data.productAssetValue) {
    const pa = data.productAssetValue;
    lines.push('--- 10. NILAI ASET PRODUK ---');
    lines.push(`Total nilai aset (stok × HPP): ${rp(pa.totalAssetValue)} (${pa.totalProducts} produk)`);
    if (pa.categoryBreakdown?.length > 0) {
      lines.push('Per kategori:');
      pa.categoryBreakdown.forEach((c: any) => {
        lines.push(`  ${c.category}: ${rp(c.assetValue)} (${c.productCount} produk)`);
      });
    }
    if (pa.topProductsByValue?.length > 0) {
      lines.push('Top 5 by aset value:');
      pa.topProductsByValue.slice(0, 5).forEach((p: any) => {
        lines.push(`  ${p.productName}: ${rp(p.assetValue)} (stok ${p.stock} × HPP ${rp(p.avgHpp)})`);
      });
    }
    lines.push('');
  }

  lines.push('=== AKHIR DATA KEUANGAN ===');

  return lines.join('\n');
}

// ============ FINANCIAL ANALYSIS INTENT DETECTION ============

/**
 * Detect if a message is a financial analysis request that needs the full snapshot data.
 * This is different from simple data queries — these need AI reasoning over financial data.
 */
function isFinancialAnalysis(msg: string): boolean {
  const q = msg.toLowerCase();

  // HPP & Profit analysis
  if (q.match(/hpp|harga\s*pokok|biaya\s*produksi/)) return true;
  if (q.match(/profit\s*(di\s*tangan|terkumpul|sudah|yang)|laba\s*(di\s*tangan|terkumpul)/)) return true;
  if (q.match(/uang\s*(yang|sudah)\s*(di\s*tangan|terkumpul|tersedia)/)) return true;
  if (q.match(/margin\s*(keuntungan|profit)/)) return true;

  // Restock & Purchase suggestions
  if (q.match(/saran\s*(beli|restock|pengadaan)/)) return true;
  if (q.match(/rekomendasi\s*(beli|restock|stok|pengadaan)/)) return true;
  if (q.match(/apa\s*(yang|saja)\s*(harus|perlu|sebaiknya)\s*di\s*(beli|restock|adakan)/)) return true;
  if (q.match(/what\s*(to|should)\s*buy/)) return true;
  if (q.match(/stok.*(kurang|habis|menipis|perlu)/)) return true;

  // Sales pattern analysis
  if (q.match(/pattern|pola\s*(penjualan|beli)/)) return true;
  if (q.match(/tren\s*(penjualan|sales|omset)/)) return true;
  if (q.match(/analisa\s*(penjualan|keuangan|bisnis|financial)/)) return true;
  if (q.match(/analisis\s*(penjualan|keuangan|bisnis|financial)/)) return true;
  if (q.match(/growth|pertumbuhan/)) return true;
  if (q.match(/penjualan.*(per\s*(bulan|2\s*bulan|3\s*bulan|minggu|kuartal))/)) return true;

  // Customer prediction
  if (q.match(/prediksi|predict|forecast/)) return true;
  if (q.match(/kemungkinan.*(konsumen|customer|pelanggan).*(beli|order|pesan)/)) return true;
  if (q.match(/konsumen\s*(mana|yang).*(akan\s*beli|bakal|next)/)) return true;
  if (q.match(/customer.*(next|akan|will)/)) return true;

  // Money flow & Discrepancy
  if (q.match(/uang\s*masuk|arus\s*kas|cash\s*flow/)) return true;
  if (q.match(/selisih|discrepancy|ketidaksesuaian/)) return true;
  if (q.match(/audit|telusuri|investigasi|cek\s*(kecocokan|kebenaran)/)) return true;
  if (q.match(/masalah\s*(keuangan|finansial|kas)/)) return true;

  // Fix & Root Cause (new)
  if (q.match(/perbaiki\s*(selisih|data)|fix.*(selisih|data)/)) return true;
  if (q.match(/penyebab\s*(selisih|masalah)/)) return true;

  // General financial health
  if (q.match(/keuangan\s*(sehat|baik|buruk|how|kondisi)/)) return true;
  if (q.match(/financial\s*(health|status|review)/)) return true;
  if (q.match(/kesehatan\s*(keuangan|bisnis|financial)/)) return true;
  if (q.match(/review\s*(keuangan|financial|bisnis)/)) return true;
  if (q.match(/laporan\s*(keuangan|financial|lengkap|komprehensif)/)) return true;
  if (q.match(/report\s*(keuangan|financial)/)) return true;

  // Asset & Debt
  if (q.match(/aset|asset\s*(value|nilai)/)) return true;
  if (q.match(/hutang|debt|piutang\s*(total|ringkasan)/)) return true;

  return false;
}

// ============ AUDIT INTENT DETECTION ============

/**
 * Detect if a message requests a deep audit (separate from general financial analysis).
 * Audit triggers the /api/ai/audit endpoint for comprehensive discrepancy analysis.
 */
function isAuditIntent(msg: string): boolean {
  const q = msg.toLowerCase();
  return !!(
    q.match(/cek\s*(apa\s*ada\s*)?selisih/) ||
    q.match(/analisa\s*selisih/) ||
    q.match(/ada\s*(tidak\s*)?selisih/) ||
    q.match(/cek\s*kecocokan\s*data/) ||
    q.match(/cek\s*kebenaran\s*data/)
  );
}

/**
 * Detect if a message requests fix recommendations for discrepancies.
 */
function isFixIntent(msg: string): boolean {
  const q = msg.toLowerCase();
  return !!(
    q.match(/perbaiki\s*selisih/) ||
    q.match(/fix\s*(selisih|discrepancy)/) ||
    q.match(/koreksi\s*data/) ||
    q.match(/rekomendasi\s*perbaikan/)
  );
}

/**
 * Detect if a message asks for root cause analysis.
 */
function isRootCauseIntent(msg: string): boolean {
  const q = msg.toLowerCase();
  return !!(
    q.match(/penyebab\s*selisih/) ||
    q.match(/kenapa\s*ada\s*selisih/) ||
    q.match(/akar\s*(masalah|penyebab)/) ||
    q.match(/root\s*cause/) ||
    q.match(/diagnosa\s*selisih/)
  );
}

/**
 * Detect if a message requests promo image generation.
 */
function isPromoIntent(msg: string): boolean {
  const q = msg.toLowerCase();
  return !!(
    q.match(/buat\s*(gambar\s*)?promo/) ||
    q.match(/generate\s*promo/) ||
    q.match(/gambar\s*promo/) ||
    q.match(/desain\s*promo/) ||
    q.match(/promotional\s*image/) ||
    q.match(/poster\s*promo/)
  );
}

// ============ LLM-POWERED CHAT ============

/**
 * Enhanced LLM chat with optional financial data context.
 * When financialData is provided, the LLM becomes a financial analyst.
 */
async function askLLM(
  message: string,
  isSuperAdmin: boolean,
  history: { role: string; content: string }[],
  financialContext?: string | null,
): Promise<string> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default;
  const zai = await ZAI.create();

  const today = format(new Date(), 'EEEE, dd MMMM yyyy', { locale: id });

  const systemPrompt = `Kamu adalah "Asisten Keuangan Razkindo" — AI Financial Analyst untuk ERP system Razkindo Group. Kamu adalah analis keuangan cerdas yang memiliki akses penuh ke semua data keuangan perusahaan.

INFO HARI INI: ${today}

KEMAMPUAN UTAMA:
1. **Analisis HPP & Profit**: Cek akumulasi uang HPP dan profit yang sudah di tangan, bandingkan dengan yang masih tertahan di piutang
2. **Saran Restock**: Analisa velocity penjualan per produk, stok tersisa, dan rekomendasikan apa yang harus dibeli berdasarkan pola penjualan aktual
3. **Analisa Pola Penjualan**: Identifikasi tren penjualan per bulan, 2 bulan, 3 bulan — pertumbuhan, penurunan, seasonal pattern
4. **Prediksi Konsumen**: Analisa pola pembelian tiap konsumen (frekuensi, produk favorit) dan prediksi kapan mereka akan order lagi
5. **Audit Arus Kas**: Telusuri semua uang masuk & keluar, deteksi selisih, inkonsistensi data, dan payment mismatch
6. **Health Check Keuangan**: Evaluasi kesehatan keuangan secara komprehensif (liquidity, solvency, profitability)
7. **Analisa Hutang & Piutang**: Monitor hutang perusahaan, overdue status, dan piutang yang perlu ditagih
8. **Nilai Aset**: Hitung dan analisa nilai aset produk berdasarkan stok dan HPP
9. **Analisa Selisih & Audit Data**: Deteksi, analisa, dan rekomendasikan perbaikan untuk inkonsistensi data keuangan (discrepancy). Jalankan deep audit dan identifikasi root cause.
10. **Generate Gambar Promo**: Buat gambar promosi profesional untuk produk (bisa diminta melalui tombol atau perintah chat)

${isSuperAdmin ? ' kamu memiliki akses penuh ke data HPP, profit, dan semua informasi keuangan sensitif.' : ''}

ATURAN PENTING:
- Gunakan Bahasa Indonesia yang profesional namun mudah dipahami
- Gunakan emoji untuk visual yang menarik (📊📈💰📦⚠️🔍✅🔴🟢🎨)
- Gunakan **bold** untuk angka/nama penting
- Selalu berikan ANALISIS dan REKOMENDASI, bukan hanya data mentah
- Jika ada masalah (selisih, overdue, stok rendah), berikan SOLVING/REKOMENDASI konkret
- Format angka uang dengan "Rp" dan pemisah ribuan
- Jawaban harus terstruktur dan mudah dibaca
- Jika ditanya sesuatu yang TIDAK ada di data, katakan dengan jujur
- Prioritaskan action items — apa yang harus segera dilakukan

CONTOH ANALISIS:
- "cek uang hpp yang terkumpul" → Berapa HPP di tangan vs tertahan, persentase, rekomendasi alokasi
- "saran barang apa yang harus dibeli" → Analisa velocity, stok, rekomendasi dengan estimasi biaya
- "analisa penjualan 3 bulan terakhir" → Tren naik/turun, growth %, insight per bulan
- "konsumen mana yang kemungkinan akan beli" → Prediksi berdasarkan pola, produk favorit, overdue status
- "cek uang masuk dan selisihnya" → Audit arus kas, deteksi discrepancy, rekomendasi perbaikan
- "kesehatan keuangan kita" → Comprehensive health check dengan skor dan rekomendasi
- "cek apakah ada selisih di data keuangan" → Deep audit data, identifikasi semua discrepancy, berikan rekomendasi fix
- "perbaiki selisih data yang ditemukan" → Analisa discrepancy, rekomendasikan fix spesifik per transaksi
- "penyebab selisih di data keuangan" → Root cause analysis, identifikasi pola dan korelasi`;

  // Build messages array
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
  ];

  // If financial context is available, inject it as a system-level data context
  if (financialContext) {
    messages.push({
      role: 'system',
      content: `DATA KEUANGAN TERKINI YANG DAPAT KAMU ANALISA:\n\n${financialContext}\n\nGunakan data di atas untuk menjawab pertanyaan user. Berikan analisis mendalam, bukan hanya merangkum data. Identifikasi pola, berikan insight, dan rekomendasikan tindakan.`
    });
  }

  // Add conversation history (last 8 messages for context)
  messages.push(...history.slice(-8).map(m => ({ role: m.role, content: m.content })));
  messages.push({ role: 'user', content: message });

  try {
    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: 'disabled' }
    });

    return completion.choices[0]?.message?.content || 'Maaf, saya tidak bisa merespons saat ini. Coba lagi nanti.';
  } catch (err: any) {
    console.error('LLM error:', err);
    return '⚠️ AI sedang tidak tersedia. Silakan coba lagi dalam beberapa saat.';
  }
}

// ============ DATA INTENT DETECTION ============

function isDataQuery(msg: string, isSuperAdmin: boolean): string | null {
  const q = msg.toLowerCase().trim();
  if (!isSuperAdmin && q.match(/penjualan.*(profit|laba|untung|hpp|margin|keuntungan)/)) return 'restricted';
  if (q.match(/penjualan.*(hari|today|hari ini)/) || q.match(/omset.*(hari|today)/)) return 'sales_today';
  if (q.match(/penjualan.*(minggu|week)/)) return 'sales_week';
  if (q.match(/penjualan.*(bulan|month)/)) return 'sales_month';
  if (q.match(/penjualan.*(sales|per sales)/)) return 'sales_per_sales';
  if (q.match(/sales.*(terbaik|top|terlaris)/)) return 'sales_per_sales';
  if (q.match(/penjualan.*(profit|laba|untung)/)) return 'sales_month';
  if (q.match(/stok.*(rendah|menipis|low)/)) return 'stock_low';
  if (q.match(/stok.*(habis|kosong)/)) return null;
  if (q.match(/stok|stock/)) return 'stock_all';
  if (q.match(/belum bayar|piutang/) && q.match(/konsumen|customer|siapa/)) return 'customers_unpaid';
  if (q.match(/total piutang|jumlah piutang/)) return 'customers_unpaid';
  if (q.match(/konsumen|customer|pelanggan/) && q.match(/ringkasan|summary|jumlah/)) return 'customers_summary';
  if (q.match(/penawaran|quotation|quote/)) return 'quotation';
  if (q.match(/mou|perjanjian|kerjasama|nota kesepahaman/)) return 'mou';
  return null;
}

// ============ MAIN HANDLER ============

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, history } = body;

    let isSuperAdmin = false;
    const userId = await verifyAuthUser(request.headers.get('authorization'));
    if (userId) {
      const { data: authUser } = await db.from('users').select('role, is_active, status').eq('id', userId).single();
      isSuperAdmin = authUser?.role === 'super_admin' && authUser?.is_active && authUser?.status === 'approved';
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'Pesan wajib diisi' }, { status: 400 });
    }

    const authHeader = request.headers.get('authorization');

    // 1. Check for data query intents first (quick responses)
    const dataIntent = isDataQuery(message, isSuperAdmin);
    let reply: string;
    let isQuotation = false;

    switch (dataIntent) {
      case 'restricted':
        reply = '🔒 Info HPP/profit hanya untuk Super Admin.';
        return NextResponse.json({ success: true, reply });
      case 'sales_today':
        reply = await handleSalesToday(isSuperAdmin);
        return NextResponse.json({ success: true, reply });
      case 'sales_week':
        reply = await handleSalesWeek(isSuperAdmin);
        return NextResponse.json({ success: true, reply });
      case 'sales_month':
        reply = await handleSalesMonth(isSuperAdmin);
        return NextResponse.json({ success: true, reply });
      case 'sales_per_sales':
        reply = await handleSalesPerSales(isSuperAdmin);
        return NextResponse.json({ success: true, reply });
      case 'stock_all':
        reply = await handleStockAll(isSuperAdmin);
        return NextResponse.json({ success: true, reply });
      case 'stock_low':
        reply = await handleStockLow();
        return NextResponse.json({ success: true, reply });
      case 'customers_unpaid':
        reply = await handleCustomersUnpaid();
        return NextResponse.json({ success: true, reply });
      case 'customers_summary':
        reply = await handleCustomersSummary();
        return NextResponse.json({ success: true, reply });
      case 'quotation': {
        const custName = message.replace(/.*penawaran\s+(untuk|kepada)?\s*/i, '').trim();
        reply = JSON.stringify({ action: 'open_quotation', customerName: custName || '' });
        return NextResponse.json({ success: true, reply, isQuotation: true });
      }
      case 'mou': {
        const partnerName = message.replace(/.*(mou|perjanjian|kerjasama|nota kesepahaman)\s+(dengan|untuk|kepada)?\s*/i, '').trim();
        reply = JSON.stringify({ action: 'open_mou', partnerName: partnerName || '' });
        return NextResponse.json({ success: true, reply, isMou: true });
      }
    }

    // 2. Use LLM for general conversation (require auth)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized — login untuk menggunakan AI chat' }, { status: 401 });
    }

    const chatHistory = Array.isArray(history) ? history : [];

    // 3. Check if this is a financial analysis query that needs data context
    let financialContext: string | null = null;
    let isFinancial = false;
    const origin = new URL(request.url).origin;

    // 3a. Deep audit intent — fetch audit endpoint for comprehensive discrepancy data
    if (isSuperAdmin && isAuditIntent(message)) {
      const auditData = await fetchAuditData(authHeader, origin);
      if (auditData) {
        financialContext = buildAuditContext(auditData);
        isFinancial = true;
      }
    }
    // 3b. Fix intent — run audit first, then let LLM recommend fixes with data
    else if (isSuperAdmin && isFixIntent(message)) {
      const auditData = await fetchAuditData(authHeader, origin);
      if (auditData) {
        const auditContext = buildAuditContext(auditData);
        financialContext = auditContext + '\n\nINSTRUKSI KHUSUS: User meminta rekomendasi perbaikan selisih. Berikan rekomendasi fix yang spesifik per transaksi, lengkap dengan field yang harus diubah, nilai yang benar, dan alasan perbaikan.';
        isFinancial = true;
      }
    }
    // 3c. Root cause intent — run audit, then let LLM analyze root cause
    else if (isSuperAdmin && isRootCauseIntent(message)) {
      const auditData = await fetchAuditData(authHeader, origin);
      if (auditData) {
        const auditContext = buildAuditContext(auditData);
        financialContext = auditContext + '\n\nINSTRUKSI KHUSUS: User meminta analisis akar penyebab (root cause) selisih. Identifikasi POLA dan KORELASI antar discrepancy, berikan DIAGNOSIS akar penyebab yang spesifik, dan rekomendasikan langkah pencegahan.';
        isFinancial = true;
      }
    }
    // 3d. Promo image intent — for super_admin, fetch products and return JSON for frontend
    else if (isSuperAdmin && isPromoIntent(message)) {
      try {
        const { data: topProducts } = await db
          .from('products')
          .select('id, name, category, unit, selling_price, image_url')
          .eq('is_active', true)
          .order('selling_price', { ascending: false })
          .limit(10);

        if (topProducts && topProducts.length > 0) {
          const productList = topProducts.map((p: any, i: number) =>
            `${i + 1}. **${p.name}** — ${rp(p.selling_price)}`
          ).join('\n');

          const promoReply = `🎨 **Generate Gambar Promo**\n\nBerikut produk teratas yang bisa dibuatkan gambar promonya:\n\n${productList}\n\n💡 **Cara membuat gambar promo:**\n1. Gunakan tombol **🎨 Gambar Promo** di bawah chat\n2. Atau ketik \`promo [nomor produk]\`, contoh: \`promo 1\`\n3. Atau ketik \`promo [nama produk]\`, contoh: \`promo semen\`\n\n📅 Tipe promo tersedia: discount, bundle, new, flash_sale`;

          return NextResponse.json({
            success: true,
            reply: promoReply,
            isFinancial: false,
            isPromoIntent: true,
            promoProducts: topProducts,
          });
        }
      } catch (err) {
        console.error('[AI Chat] Promo product fetch error:', err);
      }
      // Fallback to LLM if product fetch fails
    }
    // 3e. General financial analysis — use financial snapshot
    else if (isSuperAdmin && isFinancialAnalysis(message)) {
      const snapshotData = await fetchFinancialSnapshot(authHeader, origin);
      if (snapshotData) {
        financialContext = buildFinancialContext(snapshotData);
        isFinancial = true;
      }
    }

    // 4. Call LLM with financial context if available
    reply = await askLLM(message, isSuperAdmin, chatHistory, financialContext);

    return NextResponse.json({
      success: true,
      reply,
      isFinancial,
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    return NextResponse.json({ error: 'Gagal menganalisis data' }, { status: 500 });
  }
}

export async function DELETE() {
  return NextResponse.json({ success: true });
}
