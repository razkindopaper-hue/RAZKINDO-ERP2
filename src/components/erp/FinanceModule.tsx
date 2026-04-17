'use client';

import { useState, useMemo } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useUnitStore } from '@/stores/unit-store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { POLLING_CONFIG } from '@/providers/query-provider';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';
import { formatCurrency, formatDateTime, getInitials } from '@/lib/erp-helpers';
import type {
  BankAccount,
  CashBox,
  CompanyDebt,
  FinanceRequest,
  FundTransfer,
  Transaction,
  Payment,
} from '@/types';

import {
  DollarSign,
  TrendingUp,
  Wallet,
  Building2,
  BarChart3,
  AlertTriangle,
  Plus,
  Edit,
  Trash2,
  ArrowLeftRight,
  CircleDollarSign,
  Building,
  Warehouse,
  ArrowRight,
  PencilRuler,
  RefreshCw,
  CheckCircle2,
  Info,
  Gift,
  History,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Receipt,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';


import PiutangTab from './PiutangTab';
import CompanyDebtsTab, { ProcessRequestDialog, TransferForm, BankAccountForm, CashBoxForm } from './CompanyDebtsTab';
import { PoolAdjustForm } from './PoolAdjustForm';
import { DepositDialog } from './DepositDialog';
import CashbackWithdrawalsTab from './CashbackWithdrawalsTab';
import ExpensesTab from './ExpensesTab';

// ================================
// HELPER FUNCTIONS (outside component to avoid recreation)
// ================================

// fundSource values 'hpp_paid' and 'profit_unpaid' are enum keys stored in DB (finance_requests.fund_source).
// Despite the confusing name, 'profit_unpaid' refers to pool_profit_paid_balance (the PROFIT PAID pool).
// Both values represent PAID pools — the source of funds for finance operations.
// DO NOT change these labels without also updating all API endpoints that check these values.
const getFundSourceLabel = (fundSource?: string) => {
  if (fundSource === 'hpp_paid') return 'HPP Sudah Terbayar';
  if (fundSource === 'profit_unpaid') return 'Profit Sudah Terbayar';
  return null;
};

const getFundSourceColor = (fundSource?: string) => {
  if (fundSource === 'hpp_paid') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300';
  if (fundSource === 'profit_unpaid') return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
  return '';
};

const getRequestTypeLabel = (type: string) => {
  switch (type) {
    case 'purchase': return 'Pembelian';
    case 'salary': return 'Gaji';
    case 'expense': return 'Pengeluaran';
    case 'courier_deposit': return 'Setoran Kurir';
    case 'cash_to_bank': return 'Setor ke Bank';
    default: return type;
  }
};

const getRequestTypeColor = (type: string) => {
  switch (type) {
    case 'purchase': return 'bg-blue-500';
    case 'salary': return 'bg-purple-500';
    case 'expense': return 'bg-red-500';
    case 'courier_deposit': return 'bg-green-500';
    case 'cash_to_bank': return 'bg-amber-500';
    default: return 'bg-gray-500';
  }
};

const WorkflowInfo = ({ req }: { req: FinanceRequest }) => {
  if (req.status !== 'processed') return null;
  const fundLabel = getFundSourceLabel(req.fundSource);
  const isDebt = req.paymentType === 'debt';

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1 text-[10px]">
      {isDebt ? (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
          <Wallet className="w-2.5 h-2.5" /> Dicatat sebagai Hutang
        </span>
      ) : (
        <>
          {fundLabel && (
            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${getFundSourceColor(req.fundSource)}`}>
              <span className="font-bold">1</span> {fundLabel}
            </span>
          )}
          {(fundLabel) && (req.sourceType === 'bank' || req.sourceType === 'cashbox') && (
            <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
          )}
          {req.sourceType === 'bank' && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
              <span className="font-bold">2</span> <Building className="w-2.5 h-2.5" /> {req.bankAccount?.name || 'Rekening Bank'}
            </span>
          )}
          {req.sourceType === 'cashbox' && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              <span className="font-bold">2</span> <Warehouse className="w-2.5 h-2.5" /> {req.cashBox?.name || 'Brankas'}
            </span>
          )}
        </>
      )}
    </div>
  );
};

// ================================
// CASH FLOW TYPES
// ================================

interface CashFlowEntry {
  id: string;
  date: string;
  direction: 'in' | 'out' | 'transfer';
  category: string;
  categoryLabel: string;
  description: string;
  amount: number;
  source: string;
  destination: string;
  referenceId: string;
  referenceNo?: string;
  createdBy?: string;
  metadata?: Record<string, any>;
}

const CASHFLOW_CATEGORY_COLORS: Record<string, string> = {
  sale: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  purchase: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  expense: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  salary: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  courier_handover: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  fund_transfer: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
  cashback_withdrawal: 'bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300',
};

// ================================
// FINANCE MODULE (MAIN)
// ================================

export default function FinanceModule() {
  const { user } = useAuthStore();
  const { selectedUnitId, units } = useUnitStore();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('requests');
  const [showBankForm, setShowBankForm] = useState(false);
  const [showCashBoxForm, setShowCashBoxForm] = useState(false);
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [processingRequest, setProcessingRequest] = useState<string | null>(null);
  const [editingBank, setEditingBank] = useState<BankAccount | null>(null);
  const [editingCashBox, setEditingCashBox] = useState<CashBox | null>(null);
  const [depositingBank, setDepositingBank] = useState<BankAccount | null>(null);
  const [depositingCashBox, setDepositingCashBox] = useState<CashBox | null>(null);
  const [pendingDeleteBank, setPendingDeleteBank] = useState<{ id: string; name: string } | null>(null);
  const [pendingDeleteCashBox, setPendingDeleteCashBox] = useState<{ id: string; name: string } | null>(null);
  // Keys to force form remount when dialog opens (resets stale form state)
  const [cashBoxFormKey, setCashBoxFormKey] = useState(0);
  const [transferFormKey, setTransferFormKey] = useState(0);
  const [bankFormKey, setBankFormKey] = useState(0);
  const [poolFormKey, setPoolFormKey] = useState(0);
  const [showPoolDialog, setShowPoolDialog] = useState(false);
  
  // Fetch bank accounts
  const { data: bankAccountsData } = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: () => apiFetch<{ bankAccounts: any[] }>('/api/finance/bank-accounts'),
    ...POLLING_CONFIG
  });
  
  // Fetch cash boxes
  const { data: cashBoxesData } = useQuery({
    queryKey: ['cash-boxes'],
    queryFn: () => apiFetch<{ cashBoxes: any[] }>('/api/finance/cash-boxes'),
    ...POLLING_CONFIG
  });
  
  // Fetch finance requests (only when requests tab is active)
  const { data: financeRequestsData } = useQuery({
    queryKey: ['finance-requests'],
    queryFn: () => apiFetch<{ requests: any[] }>('/api/finance/requests'),
    enabled: activeTab === 'requests',
    ...POLLING_CONFIG
  });
  
  // Fetch fund transfers (only when transfers tab is active)
  const { data: transfersData } = useQuery({
    queryKey: ['fund-transfers'],
    queryFn: () => apiFetch<{ transfers: any[] }>('/api/finance/transfers'),
    enabled: activeTab === 'transfers',
    ...POLLING_CONFIG
  });
  
  // Cash flow history state
  const [cashflowType, setCashflowType] = useState('all');
  const [cashflowPage, setCashflowPage] = useState(1);
  const cashflowLimit = 30;

  // Fetch cash flow history (only when cashflow tab is active)
  const { data: cashflowData, isLoading: cashflowLoading } = useQuery({
    queryKey: ['cash-flow', cashflowType, cashflowPage],
    queryFn: () => apiFetch<{
      entries: CashFlowEntry[];
      summary: { totalInflow: number; totalOutflow: number; totalTransfer: number; netFlow: number; count: number };
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }>(`/api/finance/cash-flow?type=${cashflowType}&page=${cashflowPage}&limit=${cashflowLimit}`),
    enabled: activeTab === 'cashflow',
  });

  // Fetch courier cash summary (money still with couriers)
  const { data: courierCashSummary } = useQuery({
    queryKey: ['courier-cash-summary'],
    queryFn: () => apiFetch<{ totalWithCouriers: number }>('/api/courier/cash-summary'),
    ...POLLING_CONFIG
  });

  // Fetch payments (used in various tabs - e.g. creating new payments from transactions)
  // Note: HPP/Profit totals now use actualHppSum/actualProfitSum from pools API (RPC-based, no limit)
  const { data: paymentsData } = useQuery({
    queryKey: ['payments'],
    queryFn: () => apiFetch<{ payments: Payment[] }>('/api/payments'),
    ...POLLING_CONFIG
  });
  
  // Fetch pool balances from settings (tracked pool balance for 2-step workflow)
  // Settings IS the authoritative source for pool balances.
  // API returns: pool balances + physical totals + pool vs physical discrepancy + RPC audit reference
  const { data: poolBalancesData } = useQuery({
    queryKey: ['finance-pools'],
    queryFn: () => apiFetch<{
      hppPaidBalance: number; profitPaidBalance: number; investorFund: number; totalPool: number;
      totalCashInBoxes: number; totalInBanks: number; totalWithCouriers: number; totalPhysical: number;
      poolDiff: number; hasDiscrepancy: boolean;
      courierHppPending: number; courierProfitPending: number; courierCashTotal: number;
      rpcHppSum: number; rpcProfitSum: number; rpcDiff: number;
    }>('/api/finance/pools'),
    ...POLLING_CONFIG
  });
  
  // Fetch company debts (only when debts tab is active)
  const { data: debtsData } = useQuery({
    queryKey: ['company-debts'],
    queryFn: () => apiFetch<{ debts: any[] }>('/api/finance/debts'),
    enabled: activeTab === 'debts',
    ...POLLING_CONFIG
  });
  
  const bankAccounts = bankAccountsData?.bankAccounts || [];
  const cashBoxes = cashBoxesData?.cashBoxes || [];
  const financeRequests = financeRequestsData?.requests || [];
  const transfers = transfersData?.transfers || [];
  const payments = paymentsData?.payments || [];
  const debts = debtsData?.debts || [];
  
  // Fetch unpaid purchase transactions (only when debts tab is active)
  const { data: purchaseDebtsData } = useQuery({
    queryKey: ['purchase-debts'],
    queryFn: () => apiFetch<{ transactions: any[] }>('/api/transactions?type=purchase&status=approved'),
    enabled: activeTab === 'debts',
    ...POLLING_CONFIG
  });
  
  const purchaseDebts = (purchaseDebtsData?.transactions || []).filter(
    (t: Transaction) => t.paymentStatus === 'unpaid' || t.paymentStatus === 'partial'
  );
  
  // Fetch receivables (only when piutang tab is active)
  const { data: receivablesData, isLoading: receivablesLoading } = useQuery({
    queryKey: ['receivables'],
    queryFn: () => apiFetch<{ receivables: any[]; stats: any }>('/api/finance/receivables'),
    enabled: activeTab === 'piutang',
    ...POLLING_CONFIG
  });
  
  const receivables = receivablesData?.receivables || [];
  const receivableStats = receivablesData?.stats || { totalReceivable: 0, totalOverdue: 0, activeCount: 0, overdueCount: 0, unassignedCount: 0 };
  
  // Calculate fund balances
  // Settings IS the authoritative source for pool balances.
  // hppInHand/profitInHand = pool values (HPP/Profit sudah terbayar from settings).
  // totalFunds = uang fisik di perusahaan (brankas + bank + uang masih dipegang kurir).
  // poolDiff = selisih antara komposisi pool dan dana fisik.
  const fundBalances = useMemo(() => {
    // Type guard: wrap all API values with Number() to prevent React error #31
    const hppPaidBalance = Number(poolBalancesData?.hppPaidBalance) || 0;
    const profitPaidBalance = Number(poolBalancesData?.profitPaidBalance) || 0;
    const investorFund = Number(poolBalancesData?.investorFund) || 0;
    const totalPool = Number(poolBalancesData?.totalPool) || 0;

    // Physical totals from API (authoritative — computed server-side)
    const totalCashInBoxes = Number(poolBalancesData?.totalCashInBoxes) ||
      cashBoxes.reduce((sum: number, c: CashBox) => sum + c.balance, 0);
    const totalInBanks = Number(poolBalancesData?.totalInBanks) ||
      bankAccounts.reduce((sum: number, b: BankAccount) => sum + b.balance, 0);
    const totalWithCouriers = Number(poolBalancesData?.totalWithCouriers) ||
      Number(courierCashSummary?.totalWithCouriers) || 0;
    const totalPhysical = Number(poolBalancesData?.totalPhysical) ||
      (totalCashInBoxes + totalInBanks + totalWithCouriers);

    // Pool vs Physical discrepancy (from API)
    const poolDiff = Number(poolBalancesData?.poolDiff) ?? (totalPool - totalPhysical);
    const hasDiscrepancy = poolBalancesData?.hasDiscrepancy ?? (Math.abs(poolDiff) > 100);

    // Courier pending (money still with couriers, not yet in brankas)
    const courierHppPending = Number(poolBalancesData?.courierHppPending) || 0;
    const courierProfitPending = Number(poolBalancesData?.courierProfitPending) || 0;

    // RPC audit info (reference only)
    const rpcDiff = Number(poolBalancesData?.rpcDiff) || 0;

    return {
      hppInHand: hppPaidBalance,
      profitInHand: profitPaidBalance,
      totalCashInBoxes,
      totalInBanks,
      totalWithCouriers,
      totalFunds: totalPhysical,
      hppPaidBalance,
      profitPaidBalance,
      investorFund,
      totalPool,
      poolDiff,
      hasDiscrepancy,
      courierHppPending,
      courierProfitPending,
      rpcDiff,
    };
  }, [cashBoxes, bankAccounts, courierCashSummary, poolBalancesData]);
  
  // Separate requests by status
  const pendingRequests = financeRequests.filter((r: FinanceRequest) => r.status === 'pending');
  
  // Process request mutation
  const processMutation = useMutation({
    mutationFn: async (data: { id: string; status: string; processType?: string; sourceType?: string; fundSource?: string; bankAccountId?: string; cashBoxId?: string; notes?: string }) => {
      return apiFetch(`/api/finance/requests/${data.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: data.status,
          processType: data.processType,
          sourceType: data.sourceType,
          fundSource: data.fundSource,
          bankAccountId: data.bankAccountId,
          cashBoxId: data.cashBoxId,
          notes: data.notes,
          processedById: user?.id || ''
        })
      });
    },
    onSuccess: () => {
      toast.success('Request berhasil diproses');
      setProcessingRequest(null);
      queryClient.invalidateQueries({ queryKey: ['finance-requests'] });
      queryClient.invalidateQueries({ queryKey: ['salaries'] });
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
      queryClient.invalidateQueries({ queryKey: ['company-debts'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['finance-pools'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });
  
  // Create bank account mutation
  const createBankMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiFetch('/api/finance/bank-accounts', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    onSuccess: () => {
      toast.success('Rekening bank berhasil ditambahkan');
      setShowBankForm(false);
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });
  
  // Create cash box mutation
  const createCashBoxMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiFetch('/api/finance/cash-boxes', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },
    onSuccess: () => {
      toast.success('Cash box berhasil ditambahkan');
      setShowCashBoxForm(false);
      queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });
  
  // Create transfer mutation
  const createTransferMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiFetch('/api/finance/transfers', {
        method: 'POST',
        body: JSON.stringify({ ...data, processedById: user?.id || '' })
      });
    },
    onSuccess: () => {
      toast.success('Transfer berhasil dibuat');
      setShowTransferForm(false);
      queryClient.invalidateQueries({ queryKey: ['fund-transfers'] });
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });
  
  // Process transfer mutation
  const processTransferMutation = useMutation({
    mutationFn: async (data: { id: string; status: string }) => {
      return apiFetch(`/api/finance/transfers/${data.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: data.status, processedById: user?.id || '' })
      });
    },
    onSuccess: () => {
      toast.success('Transfer berhasil diproses');
      queryClient.invalidateQueries({ queryKey: ['fund-transfers'] });
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // Update bank account mutation
  const updateBankMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiFetch(`/api/finance/bank-accounts/${data.id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    onSuccess: () => {
      toast.success('Rekening bank berhasil diperbarui');
      setEditingBank(null);
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // Delete bank account mutation
  const deleteBankMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiFetch(`/api/finance/bank-accounts/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      toast.success('Rekening bank berhasil dihapus');
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // Update cash box mutation
  const updateCashBoxMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiFetch(`/api/finance/cash-boxes/${data.id}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
      });
    },
    onSuccess: () => {
      toast.success('Brankas/kas berhasil diperbarui');
      setEditingCashBox(null);
      queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // Delete cash box mutation
  const deleteCashBoxMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiFetch(`/api/finance/cash-boxes/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      toast.success('Brankas/kas berhasil dihapus');
      queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // Update pool balances mutation (manual adjustment)
  const updatePoolsMutation = useMutation({
    mutationFn: async (data: { hppPaidBalance?: number; profitPaidBalance?: number; investorFund?: number; totalPhysical: number }) => {
      return apiFetch('/api/finance/pools', {
        method: 'PUT',
        body: JSON.stringify(data)
      });
    },
    onSuccess: () => {
      toast.success('Pool dana berhasil diperbarui');
      setShowPoolDialog(false);
      queryClient.invalidateQueries({ queryKey: ['finance-pools'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // Sync preview state
  const [syncPreviewData, setSyncPreviewData] = useState<any>(null);
  const [showSyncPreview, setShowSyncPreview] = useState(false);


  const previewSyncMutation = useMutation({
    mutationFn: async () => {
      return apiFetch('/api/finance/pools', {
        method: 'POST',
        body: JSON.stringify({ action: 'preview_sync' })
      });
    },
    onSuccess: (data: any) => {
      setSyncPreviewData(data);
      setShowSyncPreview(true);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  const syncPoolsMutation = useMutation({
    mutationFn: async () => {
      return apiFetch('/api/finance/pools', {
        method: 'POST',
        body: JSON.stringify({ action: 'sync_from_payments' })
      });
    },
    onSuccess: (data: any) => {
      toast.success(data.message || 'Pool dana berhasil disinkronkan');
      setShowSyncPreview(false);
      setSyncPreviewData(null);
      queryClient.invalidateQueries({ queryKey: ['finance-pools'] });
    },
    onError: (err: any) => {
      // If sync was blocked by safety check, show the preview data from the error
      if (err?.details?.preview) {
        setSyncPreviewData(err.details.preview);
        setShowSyncPreview(true);
        toast.error(err.message || 'Sinkronisasi diblokir oleh sistem', { duration: 5000 });
      } else {
        toast.error(err.message || 'Gagal menyinkronkan pool dana');
      }
    }
  });

  const bankDepositMutation = useMutation({
    mutationFn: async ({ id, amount, description }: { id: string; amount: number; description?: string }) => {
      return apiFetch(`/api/finance/bank-accounts/${id}/deposit`, {
        method: 'POST',
        body: JSON.stringify({ amount, description })
      });
    },
    onSuccess: (data: any) => {
      toast.success(data.message || 'Dana berhasil ditambahkan');
      setDepositingBank(null);
      queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['finance-pools'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // Deposit to cash box mutation
  const cashBoxDepositMutation = useMutation({
    mutationFn: async ({ id, amount, description }: { id: string; amount: number; description?: string }) => {
      return apiFetch(`/api/finance/cash-boxes/${id}/deposit`, {
        method: 'POST',
        body: JSON.stringify({ amount, description })
      });
    },
    onSuccess: (data: any) => {
      toast.success(data.message || 'Dana berhasil ditambahkan');
      setDepositingCashBox(null);
      queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
      queryClient.invalidateQueries({ queryKey: ['finance-pools'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    }
  });

  // getRequestTypeLabel and getRequestTypeColor are defined outside the component

  return (
    <div className="space-y-4 safe-bottom w-full min-w-0 overflow-x-hidden">
      {/* Fund Balances Summary — 1 column x 6 rows on mobile */}
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-1.5 sm:gap-2">
        <Card className="min-w-0 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-950 dark:to-purple-900">
          <CardContent className="p-2.5 sm:p-4 flex items-center gap-2.5 sm:gap-2">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0">
              <DollarSign className="w-4 h-4 sm:w-5 sm:h-5 text-purple-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground leading-tight">HPP Dibayar</p>
              <p className="text-xs sm:text-lg font-bold text-purple-700 dark:text-purple-300 truncate">{formatCurrency(fundBalances.hppInHand)}</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="min-w-0 bg-gradient-to-br from-teal-50 to-teal-100 dark:from-teal-950 dark:to-teal-900">
          <CardContent className="p-2.5 sm:p-4 flex items-center gap-2.5 sm:gap-2">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-teal-500/20 flex items-center justify-center shrink-0">
              <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-teal-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground leading-tight">Profit Dibayar</p>
              <p className="text-xs sm:text-lg font-bold text-teal-700 dark:text-teal-300 truncate">{formatCurrency(fundBalances.profitInHand)}</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="min-w-0 bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-950 dark:to-amber-900">
          <CardContent className="p-2.5 sm:p-4 flex items-center gap-2.5 sm:gap-2">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
              <Wallet className="w-4 h-4 sm:w-5 sm:h-5 text-amber-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground leading-tight">Brankas</p>
              <p className="text-xs sm:text-lg font-bold text-amber-700 dark:text-amber-300 truncate">{formatCurrency(fundBalances.totalCashInBoxes)}</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="min-w-0 bg-gradient-to-br from-green-50 to-green-100 dark:from-green-950 dark:to-green-900">
          <CardContent className="p-2.5 sm:p-4 flex items-center gap-2.5 sm:gap-2">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-green-500/20 flex items-center justify-center shrink-0">
              <Building2 className="w-4 h-4 sm:w-5 sm:h-5 text-green-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground leading-tight">Bank</p>
              <p className="text-xs sm:text-lg font-bold text-green-700 dark:text-green-300 truncate">{formatCurrency(fundBalances.totalInBanks)}</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="min-w-0 bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-950 dark:to-orange-900">
          <CardContent className="p-2.5 sm:p-4 flex items-center gap-2.5 sm:gap-2">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-orange-500/20 flex items-center justify-center shrink-0">
              <BarChart3 className="w-4 h-4 sm:w-5 sm:h-5 text-orange-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground leading-tight">Dana Kurir</p>
              <p className="text-xs sm:text-lg font-bold text-orange-700 dark:text-orange-300 truncate">{formatCurrency(fundBalances.totalWithCouriers)}</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="min-w-0 bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900">
          <CardContent className="p-2.5 sm:p-4 flex items-center gap-2.5 sm:gap-2">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
              <BarChart3 className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground leading-tight">Total Dana</p>
              <p className="text-xs sm:text-lg font-bold text-emerald-700 dark:text-emerald-300 truncate">{formatCurrency(fundBalances.totalFunds)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pool Dana: Step 1 Komposisi Dana — Manual Update */}
      <Card className="min-w-0 border-dashed border-2 border-purple-200 dark:border-purple-800 bg-gradient-to-r from-purple-50/50 to-teal-50/50 dark:from-purple-950/50 dark:to-teal-950/50">
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-center justify-between mb-3 gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0">
                <CircleDollarSign className="w-4 h-4 text-purple-600" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">Pool Dana — Komposisi Dana</p>
                <p className="text-[10px] text-muted-foreground truncate">HPP + Profit + Dana Lain-lain = Total Pool Dana</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {/* Preview Sync button — shows what sync would change before applying */}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => previewSyncMutation.mutate()}
                disabled={previewSyncMutation.isPending || syncPoolsMutation.isPending}
              >
                <Info className={`w-3.5 h-3.5 ${previewSyncMutation.isPending ? 'animate-pulse' : ''}`} />
                <span className="hidden sm:inline">Preview</span>
              </Button>
              {/* Sync from payments button — now requires confirmation via preview */}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => {
                  // First show preview, then user confirms in the dialog
                  previewSyncMutation.mutate();
                }}
                disabled={syncPoolsMutation.isPending || previewSyncMutation.isPending}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncPoolsMutation.isPending ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Sinkron</span>
              </Button>
              <Dialog open={showPoolDialog} onOpenChange={(open) => { setShowPoolDialog(open); if (open) setPoolFormKey(k => k + 1); }}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
                    <PencilRuler className="w-3.5 h-3.5" />
                    Update
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <PencilRuler className="w-5 h-5" />
                      Update Komposisi Dana
                    </DialogTitle>
                    <DialogDescription>
                      Atur pembagian pool dana. Total fisik = Rekening + Brankas + Kurir = {formatCurrency(fundBalances.totalCashInBoxes + fundBalances.totalInBanks + fundBalances.totalWithCouriers)}
                    </DialogDescription>
                  </DialogHeader>
                  <PoolAdjustForm
                    key={poolFormKey}
                    totalPhysical={fundBalances.totalCashInBoxes + fundBalances.totalInBanks + fundBalances.totalWithCouriers}
                    currentHpp={fundBalances.hppPaidBalance}
                    currentProfit={fundBalances.profitPaidBalance}
                    currentInvestorFund={fundBalances.investorFund}
                    onSave={(data) => updatePoolsMutation.mutate(data)}
                    isSaving={updatePoolsMutation.isPending}
                  />
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {/* Pool breakdown — 4 columns */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="text-center p-2 sm:p-3 rounded-lg bg-purple-100/60 dark:bg-purple-900/40">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">HPP Terbayar</p>
              <p className="text-sm sm:text-base font-bold text-purple-700 dark:text-purple-300">{formatCurrency(fundBalances.hppPaidBalance)}</p>
            </div>
            <div className="text-center p-2 sm:p-3 rounded-lg bg-teal-100/60 dark:bg-teal-900/40">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">Profit Terbayar</p>
              <p className="text-sm sm:text-base font-bold text-teal-700 dark:text-teal-300">{formatCurrency(fundBalances.profitPaidBalance)}</p>
            </div>
            <div className="text-center p-2 sm:p-3 rounded-lg bg-amber-100/60 dark:bg-amber-900/40">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">Dana Lain-lain</p>
              <p className="text-sm sm:text-base font-bold text-amber-700 dark:text-amber-300">{formatCurrency(fundBalances.investorFund)}</p>
            </div>
            <div className="text-center p-2 sm:p-3 rounded-lg bg-emerald-100/60 dark:bg-emerald-900/40">
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5">Total Pool</p>
              <p className="text-sm sm:text-base font-bold text-emerald-700 dark:text-emerald-300">{formatCurrency(fundBalances.totalPool)}</p>
            </div>
          </div>

          {/* Visual bar — 3 segments + courier pending */}
          <div className="mt-3">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
              <span className="text-purple-600">HPP</span>
              <span className="text-teal-600">Profit</span>
              <div className="flex-1" />
              <span className="text-amber-600">Lain-lain</span>
              {fundBalances.totalWithCouriers > 0 && (
                <>
                  <span className="text-orange-600 ml-1">| Kurir</span>
                </>
              )}
            </div>
            <div className="h-2.5 rounded-full overflow-hidden bg-muted flex">
              <div
                className="bg-purple-500 transition-all duration-500"
                style={{ width: `${fundBalances.totalPool > 0 ? Math.max(0, (fundBalances.hppPaidBalance / fundBalances.totalPool) * 100) : 0}%` }}
              />
              <div
                className="bg-teal-500 transition-all duration-500"
                style={{ width: `${fundBalances.totalPool > 0 ? Math.max(0, (fundBalances.profitPaidBalance / fundBalances.totalPool) * 100) : 0}%` }}
              />
              <div
                className="bg-amber-400 transition-all duration-500"
                style={{ width: `${fundBalances.totalPool > 0 ? Math.max(0, (fundBalances.investorFund / fundBalances.totalPool) * 100) : 0}%` }}
              />
            </div>
          </div>

          {/* Reconciliation Info: Pool vs Dana Fisik */}
          <div className={`mt-3 p-2.5 rounded-lg text-xs space-y-1.5 ${
            Math.abs(fundBalances.poolDiff) > 100
              ? 'bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-800'
              : 'bg-green-50 border border-green-200 dark:bg-green-950/40 dark:border-green-800'
          }`}>
            {Math.abs(fundBalances.poolDiff) > 100 ? (
              <>
                <div className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Ada Selisih Pool vs Dana Fisik
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                  <div className="flex items-center justify-between sm:justify-start gap-2">
                    <span className="text-muted-foreground">Total Pool:</span>
                    <span className="font-semibold text-purple-700 dark:text-purple-300">{formatCurrency(fundBalances.totalPool)}</span>
                  </div>
                  <div className="flex items-center justify-between sm:justify-start gap-2">
                    <span className="text-muted-foreground">Dana Fisik:</span>
                    <span className="font-semibold text-emerald-700 dark:text-emerald-300">{formatCurrency(fundBalances.totalFunds)}</span>
                  </div>
                  <div className="col-span-2 flex items-center justify-between sm:justify-start gap-2">
                    <span className="text-muted-foreground">Selisih:</span>
                    <span className={`font-semibold ${fundBalances.poolDiff > 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {fundBalances.poolDiff > 0 ? '+' : ''}{formatCurrency(fundBalances.poolDiff)}
                    </span>
                  </div>
                </div>
                <div className="text-[10px] text-muted-foreground pt-0.5 break-words">
                  <Info className="w-3 h-3 inline mr-0.5" />
                  Brankas {formatCurrency(fundBalances.totalCashInBoxes)} + Bank {formatCurrency(fundBalances.totalInBanks)} + Kurir {formatCurrency(fundBalances.totalWithCouriers)} = {formatCurrency(fundBalances.totalFunds)}
                  {fundBalances.investorFund > 0 && ` — Dana Lain-lain: ${formatCurrency(fundBalances.investorFund)}`}
                </div>
                {fundBalances.poolDiff > 0 && (
                  <div className="text-[10px] text-amber-600 dark:text-amber-400 pt-0.5">
                    Pool lebih besar dari dana fisik. Cek apakah ada dana yang belum tercatat di brankas/bank/kurir.
                  </div>
                )}
                {fundBalances.poolDiff < 0 && (
                  <div className="text-[10px] text-blue-600 dark:text-blue-400 pt-0.5">
                    Dana fisik lebih besar dari pool. Mungkin ada dana dari sumber lain yang belum masuk komposisi pool.
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-1.5 font-medium text-green-700 dark:text-green-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Data Tersinkronisasi — Pool ({formatCurrency(fundBalances.totalPool)}) = Dana Fisik ({formatCurrency(fundBalances.totalFunds)})
                {fundBalances.totalWithCouriers > 0 && (
                  <span className="text-orange-600 dark:text-orange-400 ml-2">
                    (termasuk {formatCurrency(fundBalances.totalWithCouriers)} di kurir)
                  </span>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sync Preview Confirmation Dialog */}
      <Dialog open={showSyncPreview} onOpenChange={(open) => { setShowSyncPreview(open); if (!open) setSyncPreviewData(null); }}>
        <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="w-5 h-5" />
              Preview Sinkronisasi Pool Dana
            </DialogTitle>
            <DialogDescription>
              Periksa perubahan sebelum menyinkronkan pool dana dari data pembayaran
            </DialogDescription>
          </DialogHeader>

          {syncPreviewData && (
            <div className="space-y-4">
              {/* Warnings */}
              {syncPreviewData.warnings && syncPreviewData.warnings.length > 0 && (
                <div className="space-y-2">
                  {syncPreviewData.warnings.map((w: string, i: number) => (
                    <div key={i} className={`p-2.5 rounded-lg text-xs border ${
                      w.includes('⚠️') || w.includes('🚨') || w.includes('PERINGATAN') || w.includes('penurunan')
                        ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/40 dark:border-red-800 dark:text-red-300'
                        : 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300'
                    }`}>
                      <AlertTriangle className="w-3.5 h-3.5 inline mr-1 shrink-0" />
                      {w}
                    </div>
                  ))}
                </div>
              )}

              {/* Before vs After comparison */}
              <div className="grid grid-cols-2 gap-3">
                {/* BEFORE */}
                <div className="p-3 rounded-lg bg-muted border">
                  <p className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Sebelum (Sekarang)</p>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">HPP:</span>
                      <span className="font-semibold text-purple-700 dark:text-purple-300">{formatCurrency(syncPreviewData.currentHpp)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Profit:</span>
                      <span className="font-semibold text-teal-700 dark:text-teal-300">{formatCurrency(syncPreviewData.currentProfit)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Lain-lain:</span>
                      <span className="font-semibold text-amber-700 dark:text-amber-300">{formatCurrency(syncPreviewData.currentInvestorFund)}</span>
                    </div>
                    <div className="border-t pt-1 flex justify-between font-bold">
                      <span>Total Pool:</span>
                      <span className="text-emerald-700 dark:text-emerald-300">{formatCurrency(syncPreviewData.currentTotalPool)}</span>
                    </div>
                  </div>
                </div>
                {/* AFTER — RPC suggestion (referensi saja) */}
                <div className="p-3 rounded-lg border bg-green-50 border-green-200 dark:bg-green-950/40 dark:border-green-800">
                  <p className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Saran RPC (Referensi)</p>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">HPP:</span>
                      <div className="text-right">
                        <span className="font-semibold text-purple-700 dark:text-purple-300">{formatCurrency(syncPreviewData.suggestedHpp ?? syncPreviewData.newHpp)}</span>
                        {syncPreviewData.hppDelta !== 0 && (
                          syncPreviewData.hppDelta > 0
                            ? <ArrowDownLeft className="w-3 h-3 text-green-500 inline ml-1" />
                            : <ArrowUpRight className="w-3 h-3 text-red-500 inline ml-1" />
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Profit:</span>
                      <div className="text-right">
                        <span className="font-semibold text-teal-700 dark:text-teal-300">{formatCurrency(syncPreviewData.suggestedProfit ?? syncPreviewData.newProfit)}</span>
                        {syncPreviewData.profitDelta !== 0 && (
                          syncPreviewData.profitDelta > 0
                            ? <ArrowDownLeft className="w-3 h-3 text-green-500 inline ml-1" />
                            : <ArrowUpRight className="w-3 h-3 text-red-500 inline ml-1" />
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Lain-lain:</span>
                      <span className="font-semibold text-amber-700 dark:text-amber-300">{formatCurrency(syncPreviewData.currentInvestorFund)}</span>
                    </div>
                    <div className="border-t pt-1 flex justify-between font-bold">
                      <span>Total Pool:</span>
                      <span className="text-emerald-700 dark:text-emerald-300">{formatCurrency(syncPreviewData.suggestedTotalPool ?? syncPreviewData.newTotalPool)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Breakdown: RPC calculation detail (referensi audit) */}
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 dark:bg-blue-950/40 dark:border-blue-800 text-xs space-y-2">
                <p className="font-semibold text-blue-700 dark:text-blue-300">
                  📊 Rincian Perhitungan RPC (Referensi Audit)
                </p>
                <p className="text-[10px] text-blue-500 italic">Nilai di bawah adalah hasil perhitungan RPC — hanya untuk referensi, bukan sumber otoritatif.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <p className="text-[10px] text-muted-foreground">Langsung ke Brankas/Bank</p>
                    <p className="font-semibold text-purple-700 dark:text-purple-300">HPP: {formatCurrency(syncPreviewData.rpcBreakdown?.directHpp || syncPreviewData.directHpp || 0)}</p>
                    <p className="font-semibold text-teal-700 dark:text-teal-300">Profit: {formatCurrency(syncPreviewData.rpcBreakdown?.directProfit || syncPreviewData.directProfit || 0)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Setoran Kurir ke Brankas</p>
                    <p className="font-semibold text-purple-700 dark:text-purple-300">HPP: {formatCurrency(syncPreviewData.rpcBreakdown?.handoverHpp || syncPreviewData.handoverHpp || 0)}</p>
                    <p className="font-semibold text-teal-700 dark:text-teal-300">Profit: {formatCurrency(syncPreviewData.rpcBreakdown?.handoverProfit || syncPreviewData.handoverProfit || 0)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Dipotong untuk Pembelian/Biaya</p>
                    <p className="font-semibold text-red-600">HPP: -{formatCurrency(syncPreviewData.rpcBreakdown?.hppDeducted || syncPreviewData.hppDeducted || 0)}</p>
                    <p className="font-semibold text-red-600">Profit: -{formatCurrency(syncPreviewData.rpcBreakdown?.profitDeducted || syncPreviewData.profitDeducted || 0)}</p>
                  </div>
                </div>
                <div className="border-t border-blue-200 dark:border-blue-800 pt-1.5 space-y-1 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Net HPP (saran RPC):</span>
                    <span className="font-bold text-purple-700 dark:text-purple-300">{formatCurrency(syncPreviewData.suggestedHpp ?? syncPreviewData.newHpp)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Net Profit (saran RPC):</span>
                    <span className="font-bold text-teal-700 dark:text-teal-300">{formatCurrency(syncPreviewData.suggestedProfit ?? syncPreviewData.newProfit)}</span>
                  </div>
                </div>
                {/* Courier pending (not yet in pool) */}
                {(syncPreviewData.courierHppPending > 0 || syncPreviewData.courierProfitPending > 0) && (
                  <div className="border-t border-orange-200 dark:border-orange-800 pt-1.5 text-[11px] text-orange-700 dark:text-orange-300">
                    <p className="font-semibold">📦 Masih di Kurir (belum masuk pool):</p>
                    <p>HPP: {formatCurrency(syncPreviewData.courierHppPending || 0)}</p>
                    <p>Profit: {formatCurrency(syncPreviewData.courierProfitPending || 0)}</p>
                    <p className="text-[10px] text-orange-500">Akan masuk pool saat kurir setor ke brankas</p>
                  </div>
                )}
                {syncPreviewData.totalWithCourier > 0 && (
                  <div className="border-t border-blue-200 dark:border-blue-800 pt-1.5 text-[10px]">
                    <span className="text-muted-foreground">Total termasuk kurir:</span>{' '}
                    <span className="font-semibold text-blue-700 dark:text-blue-300">{formatCurrency(syncPreviewData.totalWithCourier)}</span>
                  </div>
                )}
              </div>

              {/* Changes detail */}
              {syncPreviewData.changes && syncPreviewData.changes.length > 0 && (
                <div className="p-3 rounded-lg bg-muted text-xs space-y-1.5">
                  <p className="font-semibold">Perubahan:</p>
                  {syncPreviewData.changes.map((c: any, i: number) => (
                    <div key={i} className="flex justify-between items-center">
                      <span className="text-muted-foreground">{c.field}:</span>
                      <span className="font-mono">
                        {formatCurrency(c.from)} → {formatCurrency(c.to)}
                        <span className={`ml-1.5 ${c.delta > 0 ? 'text-green-600' : 'text-red-600'}`}>
                          ({c.delta > 0 ? '+' : ''}{formatCurrency(c.delta)})
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Action buttons — simple accept/cancel, no blocking */}
              <div className="flex flex-col gap-2">
                <Button
                  onClick={() => syncPoolsMutation.mutate()}
                  disabled={syncPoolsMutation.isPending}
                  className={`w-full ${syncPreviewData.warnings && syncPreviewData.warnings.length > 0 ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
                >
                  {syncPoolsMutation.isPending ? 'Menyinkronkan...' : syncPreviewData.warnings && syncPreviewData.warnings.length > 0 ? '⚠️ Terapkan Saran RPC (Ada Peringatan)' : '✓ Terapkan Saran RPC'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setShowSyncPreview(false); setSyncPreviewData(null); }}
                  className="w-full"
                >
                  Batal
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      
      {/* Pending Requests Alert */}
      {pendingRequests.length > 0 && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800">
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <AlertTriangle className="w-4 h-4 sm:w-5 sm:h-5 text-amber-600 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-sm sm:text-base text-amber-800 dark:text-amber-200 truncate">
                  {pendingRequests.length} request menunggu persetujuan
                </p>
                <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-400 truncate">
                  Total: {formatCurrency(pendingRequests.reduce((sum: number, r: FinanceRequest) => sum + r.amount, 0))}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        {/* Mobile: Dropdown selector */}
        <div className="sm:hidden">
          <Select value={activeTab} onValueChange={setActiveTab}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Pilih menu" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="requests">
                <span className="inline-flex items-center gap-2">
                  <DollarSign className="w-4 h-4" />
                  <span>Request</span>
                  {pendingRequests.length > 0 && (
                    <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center">{pendingRequests.length}</span>
                  )}
                </span>
              </SelectItem>
              <SelectItem value="expenses">
                <span className="inline-flex items-center gap-2">
                  <Receipt className="w-4 h-4" />
                  <span>Pengeluaran</span>
                </span>
              </SelectItem>
              <SelectItem value="transfers">
                <span className="inline-flex items-center gap-2">
                  <ArrowLeftRight className="w-4 h-4" />
                  <span>Transfer</span>
                </span>
              </SelectItem>
              <SelectItem value="banks">
                <span className="inline-flex items-center gap-2">
                  <Building2 className="w-4 h-4" />
                  <span>Rekening</span>
                </span>
              </SelectItem>
              <SelectItem value="cashbox">
                <span className="inline-flex items-center gap-2">
                  <Wallet className="w-4 h-4" />
                  <span>Brankas</span>
                </span>
              </SelectItem>
              <SelectItem value="piutang">
                <span className="inline-flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  <span>Piutang</span>
                  {receivableStats.overdueCount > 0 && (
                    <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center">{receivableStats.overdueCount}</span>
                  )}
                </span>
              </SelectItem>
              <SelectItem value="cashback">
                <span className="inline-flex items-center gap-2">
                  <Gift className="w-4 h-4" />
                  <span>Pencairan</span>
                </span>
              </SelectItem>
              <SelectItem value="cashflow">
                <span className="inline-flex items-center gap-2">
                  <History className="w-4 h-4" />
                  <span>Arus Kas</span>
                </span>
              </SelectItem>
              <SelectItem value="debts">
                <span className="inline-flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Hutang</span>
                  {(debts.filter((d: CompanyDebt) => d.status === 'active').length + purchaseDebts.length) > 0 && (
                    <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center">{debts.filter((d: CompanyDebt) => d.status === 'active').length + purchaseDebts.length}</span>
                  )}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Desktop: Tab buttons */}
        <TabsList className="hidden sm:flex overflow-x-auto scrollbar-hide">
          <TabsTrigger value="requests" className="relative shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <DollarSign className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Request
            {pendingRequests.length > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                {pendingRequests.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="expenses" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <Receipt className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Pengeluaran
          </TabsTrigger>
          <TabsTrigger value="transfers" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <ArrowLeftRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Transfer
          </TabsTrigger>
          <TabsTrigger value="banks" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <Building2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Rekening
          </TabsTrigger>
          <TabsTrigger value="cashbox" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <Wallet className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Brankas
          </TabsTrigger>
          <TabsTrigger value="cashback" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <Gift className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Pencairan
          </TabsTrigger>
          <TabsTrigger value="cashflow" className="shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <History className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Arus Kas
          </TabsTrigger>
          <TabsTrigger value="piutang" className="relative shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <TrendingUp className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Piutang
            {receivableStats.overdueCount > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                {receivableStats.overdueCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="debts" className="relative shrink-0 whitespace-nowrap text-xs sm:text-sm gap-1">
            <AlertTriangle className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            Hutang
            {(debts.filter((d: CompanyDebt) => d.status === 'active').length + purchaseDebts.length) > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                {debts.filter((d: CompanyDebt) => d.status === 'active').length + purchaseDebts.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
        
        {/* Requests Tab */}
        <TabsContent value="requests" className="space-y-4">
          <Card>
            <CardHeader className="px-4 sm:px-6 pt-4 sm:pt-6">
              <CardTitle className="text-sm sm:text-base">Request Keuangan</CardTitle>
              <CardDescription className="text-xs sm:text-sm">Daftar request yang memerlukan persetujuan Finance</CardDescription>
            </CardHeader>
            <CardContent className="p-0 overflow-hidden">
              {/* Desktop Table */}
              <div className="hidden md:block overflow-hidden min-w-0">
              <div className="max-h-[600px] overflow-y-auto overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap w-[90px] min-w-[90px]">Tipe</TableHead>
                      <TableHead className="whitespace-nowrap min-w-0">Deskripsi</TableHead>
                      <TableHead className="whitespace-nowrap text-right w-[130px] min-w-[130px]">Jumlah</TableHead>
                      <TableHead className="whitespace-nowrap w-[100px] min-w-[100px]">Status</TableHead>
                      <TableHead className="whitespace-nowrap w-[110px] min-w-[110px]">Tanggal</TableHead>
                      <TableHead className="whitespace-nowrap text-center w-[90px] min-w-[90px]">Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {financeRequests.map((req: FinanceRequest) => (
                      <TableRow key={req.id}>
                        <TableCell>
                          <Badge className={getRequestTypeColor(req.type)}>
                            {getRequestTypeLabel(req.type)}
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-0">
                          <div className="max-w-[200px] truncate">
                            <p className="font-medium truncate">{req.description}</p>
                            {req.supplier && (
                              <p className="text-xs text-muted-foreground truncate">Supplier: {req.supplier.name}</p>
                            )}
                            {req.type === 'salary' && req.salaryPayment && (
                              <div className="flex items-center gap-1 mt-1">
                                <Avatar className="h-5 w-5">
                                  <AvatarFallback className="text-[10px]">{getInitials(req.salaryPayment.user?.name || '?')}</AvatarFallback>
                                </Avatar>
                                <p className="text-xs text-muted-foreground truncate">
                                  {req.salaryPayment.user?.name} • {req.salaryPayment.user?.role}
                                </p>
                              </div>
                            )}
                            <WorkflowInfo req={req} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-bold whitespace-nowrap">{formatCurrency(req.amount)}</TableCell>
                        <TableCell>
                          <Badge variant={
                            req.status === 'pending' ? 'secondary' :
                            req.status === 'approved' ? 'default' :
                            req.status === 'processed' ? 'default' : 'destructive'
                          }>
                            {req.status === 'pending' ? 'Menunggu' :
                             req.status === 'approved' ? 'Disetujui' :
                             req.status === 'processed' ? 'Selesai Diproses' : 'Ditolak'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">{formatDateTime(req.createdAt)}</TableCell>
                        <TableCell className="shrink-0">
                          {req.status === 'pending' && (
                            <Dialog open={processingRequest === req.id} onOpenChange={(open) => setProcessingRequest(open ? req.id : null)}>
                              <DialogTrigger asChild>
                                <Button size="sm" variant="outline">
                                  <Edit className="w-4 h-4 mr-1" />
                                  Proses
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="sm:max-w-2xl w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                                <DialogHeader>
                                  <DialogTitle>Proses Request - {getRequestTypeLabel(req.type)}</DialogTitle>
                                  <DialogDescription>
                                    {req.description}
                                  </DialogDescription>
                                </DialogHeader>
                                <ProcessRequestDialog
                                  request={req}
                                  bankAccounts={bankAccounts}
                                  cashBoxes={cashBoxes}
                                  fundBalances={fundBalances}
                                  onProcess={(data) => processMutation.mutate(data)}
                                  isProcessing={processMutation.isPending}
                                />
                              </DialogContent>
                            </Dialog>
                          )}
                          {req.status === 'approved' && req.type === 'salary' && (
                            <Dialog open={processingRequest === req.id} onOpenChange={(open) => setProcessingRequest(open ? req.id : null)}>
                              <DialogTrigger asChild>
                                <Button size="sm" variant="outline" className="bg-green-50 border-green-300 text-green-700 hover:bg-green-100">
                                  <DollarSign className="w-4 h-4 mr-1" />
                                  Bayar Gaji
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="sm:max-w-2xl w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                                <DialogHeader>
                                  <DialogTitle>Bayar Gaji - {req.salaryPayment?.user?.name}</DialogTitle>
                                  <DialogDescription>
                                    Gaji sudah disetujui. Pilih komposisi dana untuk pembayaran.
                                  </DialogDescription>
                                </DialogHeader>
                                <ProcessRequestDialog
                                  request={{ ...req, forcePayNow: true }}
                                  bankAccounts={bankAccounts}
                                  cashBoxes={cashBoxes}
                                  fundBalances={fundBalances}
                                  onProcess={(data) => processMutation.mutate(data)}
                                  isProcessing={processMutation.isPending}
                                />
                              </DialogContent>
                            </Dialog>
                          )}
                          {req.status === 'processed' && (
                            <Badge className="bg-green-500">Selesai</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {financeRequests.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                          Belum ada request
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              </div>

                {/* Mobile Card View */}
                <div className="block md:hidden p-3 space-y-2">
                  {financeRequests.map((req: FinanceRequest) => (
                    <div key={req.id} className="p-3 border rounded-lg space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge className={`shrink-0 ${getRequestTypeColor(req.type)}`}>
                            {getRequestTypeLabel(req.type)}
                          </Badge>
                          <span className="font-medium text-sm min-w-0 truncate">{req.description}</span>
                        </div>
                        <Badge variant={
                          req.status === 'pending' ? 'secondary' :
                          req.status === 'approved' ? 'default' :
                          req.status === 'processed' ? 'default' : 'destructive'
                        } className="shrink-0 text-xs">
                          {req.status === 'pending' ? 'Menunggu' :
                           req.status === 'approved' ? 'Disetujui' :
                           req.status === 'processed' ? 'Selesai Diproses' : 'Ditolak'}
                        </Badge>
                      </div>
                      {(req.supplier || (req.type === 'salary' && req.salaryPayment)) && (
                        <div className="text-xs text-muted-foreground min-w-0">
                          {req.supplier && <span className="truncate block">{req.supplier.name}</span>}
                          {req.type === 'salary' && req.salaryPayment && (
                            <span>{req.supplier ? ' • ' : ''}{req.salaryPayment.user?.name} • {req.salaryPayment.user?.role}</span>
                          )}
                        </div>
                      )}
                      <WorkflowInfo req={req} />
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <span className="font-semibold text-sm truncate">{formatCurrency(req.amount)}</span>
                        <span className="text-xs text-muted-foreground shrink-0">{formatDateTime(req.createdAt)}</span>
                      </div>
                      <div className="flex justify-end gap-1">
                        {req.status === 'pending' && (
                          <Dialog open={processingRequest === req.id} onOpenChange={(open) => setProcessingRequest(open ? req.id : null)}>
                            <DialogTrigger asChild>
                              <Button size="sm" variant="outline" className="h-7 text-xs">
                                <Edit className="w-3 h-3 mr-1" />
                                Proses
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-2xl w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                              <DialogHeader>
                                <DialogTitle>Proses Request - {getRequestTypeLabel(req.type)}</DialogTitle>
                                <DialogDescription>{req.description}</DialogDescription>
                              </DialogHeader>
                              <ProcessRequestDialog
                                request={req}
                                bankAccounts={bankAccounts}
                                cashBoxes={cashBoxes}
                                fundBalances={fundBalances}
                                onProcess={(data) => processMutation.mutate(data)}
                                isProcessing={processMutation.isPending}
                              />
                            </DialogContent>
                          </Dialog>
                        )}
                        {req.status === 'approved' && req.type === 'salary' && (
                          <Dialog open={processingRequest === req.id} onOpenChange={(open) => setProcessingRequest(open ? req.id : null)}>
                            <DialogTrigger asChild>
                              <Button size="sm" variant="outline" className="h-7 text-xs bg-green-50 border-green-300 text-green-700 hover:bg-green-100">
                                <DollarSign className="w-3 h-3 mr-1" />
                                Bayar
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-2xl w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                              <DialogHeader>
                                <DialogTitle>Bayar Gaji - {req.salaryPayment?.user?.name}</DialogTitle>
                                <DialogDescription>Gaji sudah disetujui. Pilih komposisi dana untuk pembayaran.</DialogDescription>
                              </DialogHeader>
                              <ProcessRequestDialog
                                request={{ ...req, forcePayNow: true }}
                                bankAccounts={bankAccounts}
                                cashBoxes={cashBoxes}
                                fundBalances={fundBalances}
                                onProcess={(data) => processMutation.mutate(data)}
                                isProcessing={processMutation.isPending}
                              />
                            </DialogContent>
                          </Dialog>
                        )}
                        {req.status === 'processed' && (
                          <Badge className="bg-green-500 text-xs">Selesai</Badge>
                        )}
                      </div>
                    </div>
                  ))}
                  {financeRequests.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      Belum ada request
                    </div>
                  )}
                </div>
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Expenses Tab */}
        <TabsContent value="expenses" className="space-y-4">
          <ExpensesTab bankAccounts={bankAccounts} cashBoxes={cashBoxes} />
        </TabsContent>

        {/* Transfers Tab */}
        <TabsContent value="transfers" className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center">
            <h3 className="font-semibold text-sm sm:text-base">Transfer Dana</h3>
            <Dialog open={showTransferForm} onOpenChange={(open) => { setShowTransferForm(open); if (open) setTransferFormKey(k => k + 1); }}>
              <DialogTrigger asChild>
                <Button size="sm" className="w-full sm:w-auto">
                  <Plus className="w-4 h-4 mr-2" />
                  Transfer Baru
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Transfer Dana</DialogTitle>
                  <DialogDescription>Pindahkan dana antar rekening atau dari brankas ke bank</DialogDescription>
                </DialogHeader>
                <TransferForm
                  key={transferFormKey}
                  bankAccounts={bankAccounts}
                  cashBoxes={cashBoxes}
                  onSubmit={(data) => createTransferMutation.mutate(data)}
                  isLoading={createTransferMutation.isPending}
                />
              </DialogContent>
            </Dialog>
          </div>
          
          <Card>
            <CardContent className="p-0 overflow-hidden">
              {/* Desktop Table */}
              <div className="hidden md:block overflow-hidden min-w-0">
              <div className="overflow-x-auto min-w-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap w-[110px] min-w-[110px]">Tipe</TableHead>
                    <TableHead className="whitespace-nowrap min-w-0">Dari</TableHead>
                    <TableHead className="whitespace-nowrap min-w-0">Ke</TableHead>
                    <TableHead className="whitespace-nowrap text-right w-[130px] min-w-[130px]">Jumlah</TableHead>
                    <TableHead className="whitespace-nowrap w-[90px] min-w-[90px]">Status</TableHead>
                    <TableHead className="whitespace-nowrap text-center w-[80px] min-w-[80px]">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transfers.map((t: FundTransfer) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Badge variant="outline">
                          {t.type === 'cash_to_bank' ? 'Brankas → Bank' :
                           t.type === 'bank_to_bank' ? 'Bank → Bank' : 'Bank → Brankas'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {t.fromBankAccount?.name || t.fromCashBox?.name || '-'}
                      </TableCell>
                      <TableCell>
                        {t.toBankAccount?.name || t.toCashBox?.name || '-'}
                      </TableCell>
                      <TableCell className="text-right font-bold">{formatCurrency(t.amount)}</TableCell>
                      <TableCell>
                        <Badge className={
                          t.status === 'completed' ? 'bg-green-500' :
                          t.status === 'pending' ? 'bg-amber-500' : 'bg-red-500'
                        }>
                          {t.status === 'completed' ? 'Selesai' :
                           t.status === 'pending' ? 'Pending' : 'Batal'}
                        </Badge>
                      </TableCell>
                      <TableCell className="shrink-0">
                        {t.status === 'pending' && (
                          <Button 
                            size="sm"
                            onClick={() => processTransferMutation.mutate({ id: t.id, status: 'completed' })}
                            disabled={processTransferMutation.isPending}
                          >
                            Proses
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {transfers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        Belum ada transfer
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              </div>
              </div>

              {/* Mobile Card View */}
              <div className="block md:hidden p-3 space-y-2">
                {transfers.map((t: FundTransfer) => (
                  <div key={t.id} className="p-3 border rounded-lg space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="text-xs shrink-0">
                        {t.type === 'cash_to_bank' ? 'Brankas → Bank' :
                         t.type === 'bank_to_bank' ? 'Bank → Bank' : 'Bank → Brankas'}
                      </Badge>
                      <Badge className={`shrink-0 text-xs ${
                        t.status === 'completed' ? 'bg-green-500' :
                        t.status === 'pending' ? 'bg-amber-500' : 'bg-red-500'
                      }`}>
                        {t.status === 'completed' ? 'Selesai' :
                         t.status === 'pending' ? 'Pending' : 'Batal'}
                      </Badge>
                    </div>
                    <div className="text-sm min-w-0">
                      <span className="text-muted-foreground truncate">{t.fromBankAccount?.name || t.fromCashBox?.name || '-'}</span>
                      <span className="mx-1.5">→</span>
                      <span className="font-medium truncate">{t.toBankAccount?.name || t.toCashBox?.name || '-'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <span className="font-semibold text-sm truncate">{formatCurrency(t.amount)}</span>
                      {t.status === 'pending' && (
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => processTransferMutation.mutate({ id: t.id, status: 'completed' })}
                          disabled={processTransferMutation.isPending}
                        >
                          Proses
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {transfers.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Belum ada transfer
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Bank Accounts Tab */}
        <TabsContent value="banks" className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center">
            <h3 className="font-semibold text-sm sm:text-base">Rekening Bank</h3>
            <Dialog open={showBankForm} onOpenChange={(open) => { setShowBankForm(open); if (open) setBankFormKey(k => k + 1); }}>
              <DialogTrigger asChild>
                <Button size="sm" className="w-full sm:w-auto">
                  <Plus className="w-4 h-4 mr-2" />
                  Tambah Rekening
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Tambah Rekening Bank</DialogTitle>
                  <DialogDescription className="sr-only">Form untuk menambah rekening bank</DialogDescription>
                </DialogHeader>
                <BankAccountForm
                  key={bankFormKey}
                  onSubmit={(data) => createBankMutation.mutate(data)}
                  isLoading={createBankMutation.isPending}
                />
              </DialogContent>
            </Dialog>
          </div>
          
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-2">
            {bankAccounts.map((b: BankAccount) => (
              <Card key={b.id}>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-sm sm:text-base truncate">{b.name}</CardTitle>
                      <CardDescription className="text-xs sm:text-sm truncate">{b.bankName}</CardDescription>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 sm:h-7 sm:w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950"
                        onClick={() => setDepositingBank(b)}
                        title="Tambah Dana"
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 sm:h-7 sm:w-7"
                        onClick={() => setEditingBank(b)}
                        title="Edit"
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 sm:h-7 sm:w-7 text-red-500 hover:text-red-600"
                        onClick={() => setPendingDeleteBank({ id: b.id, name: `${b.name} (${b.bankName})` })}
                        disabled={deleteBankMutation.isPending}
                        title="Hapus"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <div className="space-y-1.5 sm:space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] sm:text-xs text-muted-foreground">Pemilik Rekening</p>
                        <p className="font-medium text-sm sm:text-base truncate">{b.accountHolder}</p>
                      </div>
                      <div className="sm:text-right shrink-0 min-w-0">
                        <p className="text-[10px] sm:text-xs text-muted-foreground">Saldo</p>
                        <p className="text-base sm:text-xl font-bold text-green-600 truncate">{formatCurrency(b.balance)}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[10px] sm:text-xs text-muted-foreground">
                      <span className="truncate">No. {b.accountNo}</span>
                      {b.branch && <span className="truncate">{b.branch}</span>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
            {bankAccounts.length === 0 && (
              <Card className="col-span-2">
                <CardContent className="py-8 text-center text-muted-foreground">
                  Belum ada rekening bank. Tambahkan rekening untuk memulai.
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Edit Bank Account Dialog */}
        <Dialog open={!!editingBank} onOpenChange={(open) => { if (!open) setEditingBank(null); }}>
          <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Edit className="w-5 h-5" />
                Edit Rekening Bank
              </DialogTitle>
              <DialogDescription className="sr-only">Form untuk mengedit rekening bank</DialogDescription>
            </DialogHeader>
            {editingBank && (
              <BankAccountForm
                onSubmit={(data) => updateBankMutation.mutate({ ...data, id: editingBank.id })}
                isLoading={updateBankMutation.isPending}
                initialData={editingBank}
              />
            )}
          </DialogContent>
        </Dialog>
        
        {/* Cash Boxes Tab */}
        <TabsContent value="cashbox" className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center">
            <h3 className="font-semibold text-sm sm:text-base">Brankas / Kas</h3>
            <Dialog open={showCashBoxForm} onOpenChange={(open) => { setShowCashBoxForm(open); if (open) setCashBoxFormKey(k => k + 1); }}>
              <DialogTrigger asChild>
                <Button size="sm" className="w-full sm:w-auto">
                  <Plus className="w-4 h-4 mr-2" />
                  Tambah Brankas
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Tambah Brankas/Kas</DialogTitle>
                  <DialogDescription className="sr-only">Form untuk menambah brankas atau kas</DialogDescription>
                </DialogHeader>
                <CashBoxForm
                  key={cashBoxFormKey}
                  units={units}
                  onSubmit={(data) => createCashBoxMutation.mutate(data)}
                  isLoading={createCashBoxMutation.isPending}
                />
              </DialogContent>
            </Dialog>
          </div>
          
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-2">
            {cashBoxes.map((c: CashBox) => (
              <Card key={c.id}>
                <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
                  <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-sm sm:text-base truncate">{c.name}</CardTitle>
                      <CardDescription className="text-xs sm:text-sm truncate">{c.unit?.name || 'Kantor Pusat'}</CardDescription>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 sm:h-7 sm:w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950"
                        onClick={() => setDepositingCashBox(c)}
                        title="Tambah Dana"
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 sm:h-7 sm:w-7"
                        onClick={() => setEditingCashBox(c)}
                        title="Edit"
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 sm:h-7 sm:w-7 text-red-500 hover:text-red-600"
                        onClick={() => setPendingDeleteCashBox({ id: c.id, name: c.name })}
                        disabled={deleteCashBoxMutation.isPending}
                        title="Hapus"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <div className="flex items-center justify-between min-w-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] sm:text-xs text-muted-foreground">Tipe</p>
                      <p className="font-medium text-sm sm:text-base truncate">Cash Box</p>
                    </div>
                    <div className="text-right shrink-0 ml-3 min-w-0">
                      <p className="text-[10px] sm:text-xs text-muted-foreground">Saldo</p>
                      <p className="text-lg sm:text-xl font-bold text-amber-600 truncate">{formatCurrency(c.balance)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
            {cashBoxes.length === 0 && (
              <Card className="col-span-2">
                <CardContent className="py-8 text-center text-muted-foreground">
                  Belum ada brankas/kas. Tambahkan brankas untuk menyimpan uang tunai.
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Edit Cash Box Dialog */}
        <Dialog open={!!editingCashBox} onOpenChange={(open) => { if (!open) setEditingCashBox(null); }}>
          <DialogContent className="sm:max-w-lg w-[calc(100%-2rem)] max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Edit className="w-5 h-5" />
                Edit Brankas/Kas
              </DialogTitle>
              <DialogDescription className="sr-only">Form untuk mengedit brankas atau kas</DialogDescription>
            </DialogHeader>
            {editingCashBox && (
              <CashBoxForm
                units={units}
                onSubmit={(data) => updateCashBoxMutation.mutate({ ...data, id: editingCashBox.id })}
                isLoading={updateCashBoxMutation.isPending}
                initialData={editingCashBox}
              />
            )}
          </DialogContent>
        </Dialog>

        {/* Deposit to Bank Dialog */}
        <DepositDialog
          open={!!depositingBank}
          onOpenChange={(open) => { if (!open) setDepositingBank(null); }}
          targetName={depositingBank ? `${depositingBank.name} (${depositingBank.bankName})` : ''}
          currentBalance={depositingBank?.balance ?? 0}
          onDeposit={(amount, description) => depositingBank && bankDepositMutation.mutate({ id: depositingBank.id, amount, description })}
          isSaving={bankDepositMutation.isPending}
        />

        {/* Deposit to Cash Box Dialog */}
        <DepositDialog
          open={!!depositingCashBox}
          onOpenChange={(open) => { if (!open) setDepositingCashBox(null); }}
          targetName={depositingCashBox ? `Brankas ${depositingCashBox.name}` : ''}
          currentBalance={depositingCashBox?.balance ?? 0}
          onDeposit={(amount, description) => depositingCashBox && cashBoxDepositMutation.mutate({ id: depositingCashBox.id, amount, description })}
          isSaving={cashBoxDepositMutation.isPending}
        />
        
        {/* Piutang Tab */}
        <TabsContent value="cashback" className="space-y-4">
          <CashbackWithdrawalsTab
            bankAccounts={bankAccounts}
            cashBoxes={cashBoxes}
            poolBalances={{ hppPaidBalance: fundBalances.hppPaidBalance, profitPaidBalance: fundBalances.profitPaidBalance }}
          />
        </TabsContent>

        {/* Arus Kas (Cash Flow History) Tab */}
        <TabsContent value="cashflow" className="space-y-4">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2">
            <Card className="min-w-0 bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900">
              <CardContent className="p-2.5 sm:p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <ArrowUpRight className="w-3.5 h-3.5 text-emerald-600" />
                  <p className="text-[10px] sm:text-xs text-muted-foreground">Uang Masuk</p>
                </div>
                <p className="text-xs sm:text-base font-bold text-emerald-700 dark:text-emerald-300">
                  {formatCurrency(Number(cashflowData?.summary?.totalInflow) || 0)}
                </p>
              </CardContent>
            </Card>
            <Card className="min-w-0 bg-gradient-to-br from-red-50 to-red-100 dark:from-red-950 dark:to-red-900">
              <CardContent className="p-2.5 sm:p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <ArrowDownLeft className="w-3.5 h-3.5 text-red-600" />
                  <p className="text-[10px] sm:text-xs text-muted-foreground">Uang Keluar</p>
                </div>
                <p className="text-xs sm:text-base font-bold text-red-700 dark:text-red-300">
                  {formatCurrency(Number(cashflowData?.summary?.totalOutflow) || 0)}
                </p>
              </CardContent>
            </Card>
            <Card className="min-w-0 bg-gradient-to-br from-cyan-50 to-cyan-100 dark:from-cyan-950 dark:to-cyan-900">
              <CardContent className="p-2.5 sm:p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <ArrowLeftRight className="w-3.5 h-3.5 text-cyan-600" />
                  <p className="text-[10px] sm:text-xs text-muted-foreground">Transfer</p>
                </div>
                <p className="text-xs sm:text-base font-bold text-cyan-700 dark:text-cyan-300">
                  {formatCurrency(Number(cashflowData?.summary?.totalTransfer) || 0)}
                </p>
              </CardContent>
            </Card>
            <Card className={`min-w-0 bg-gradient-to-br ${(Number(cashflowData?.summary?.netFlow) || 0) >= 0 ? 'from-teal-50 to-teal-100 dark:from-teal-950 dark:to-teal-900' : 'from-orange-50 to-orange-100 dark:from-orange-950 dark:to-orange-900'}`}>
              <CardContent className="p-2.5 sm:p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <BarChart3 className={`w-3.5 h-3.5 ${(Number(cashflowData?.summary?.netFlow) || 0) >= 0 ? 'text-teal-600' : 'text-orange-600'}`} />
                  <p className="text-[10px] sm:text-xs text-muted-foreground">Arus Bersih</p>
                </div>
                <p className={`text-xs sm:text-base font-bold ${(Number(cashflowData?.summary?.netFlow) || 0) >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-orange-700 dark:text-orange-300'}`}>
                  {(Number(cashflowData?.summary?.netFlow) || 0) >= 0 ? '+' : ''}{formatCurrency(Number(cashflowData?.summary?.netFlow) || 0)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Filter + Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={cashflowType} onValueChange={(v) => { setCashflowType(v); setCashflowPage(1); }}>
              <SelectTrigger className="w-auto min-w-[140px] h-8 text-xs">
                <SelectValue placeholder="Filter tipe" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Arus</SelectItem>
                <SelectItem value="inflow">Uang Masuk</SelectItem>
                <SelectItem value="outflow">Uang Keluar</SelectItem>
                <SelectItem value="transfer">Transfer Internal</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-[11px] text-muted-foreground ml-auto">
              {cashflowData?.pagination?.total || 0} transaksi
            </div>
          </div>

          {/* Cash Flow Table */}
          <Card>
            <CardContent className="p-0 overflow-hidden">
              {cashflowLoading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : !cashflowData?.entries?.length ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <History className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-sm">Belum ada riwayat arus kas</p>
                </div>
              ) : (
                <>
                  {/* Desktop Table */}
                  <div className="hidden md:block overflow-hidden min-w-0">
                    <div className="max-h-[600px] overflow-y-auto overflow-x-auto min-w-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="whitespace-nowrap text-[11px] w-[95px] min-w-[95px]">Tanggal</TableHead>
                            <TableHead className="whitespace-nowrap text-[11px] w-[60px] min-w-[60px]">Arah</TableHead>
                            <TableHead className="whitespace-nowrap text-[11px] w-[90px] min-w-[90px]">Kategori</TableHead>
                            <TableHead className="whitespace-nowrap text-[11px] min-w-0">Deskripsi</TableHead>
                            <TableHead className="whitespace-nowrap text-[11px] min-w-0">Asal</TableHead>
                            <TableHead className="whitespace-nowrap text-[11px] min-w-0">Tujuan</TableHead>
                            <TableHead className="whitespace-nowrap text-[11px] text-right w-[120px] min-w-[120px]">Jumlah</TableHead>
                            <TableHead className="whitespace-nowrap text-[11px] w-[80px] min-w-[80px]">Oleh</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(cashflowData.entries || []).map((entry: CashFlowEntry) => (
                            <TableRow key={entry.id}>
                              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                {formatDateTime(entry.date)}
                              </TableCell>
                              <TableCell>
                                {entry.direction === 'in' && (
                                  <ArrowUpRight className="w-4 h-4 text-emerald-600" />
                                )}
                                {entry.direction === 'out' && (
                                  <ArrowDownLeft className="w-4 h-4 text-red-600" />
                                )}
                                {entry.direction === 'transfer' && (
                                  <ArrowLeftRight className="w-4 h-4 text-cyan-600" />
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge className={`text-[10px] ${CASHFLOW_CATEGORY_COLORS[entry.category] || 'bg-gray-100 text-gray-700'}`}>
                                  {entry.categoryLabel}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs max-w-[200px]">
                                <p className="font-medium truncate">{entry.description}</p>
                                {entry.referenceNo && (
                                  <p className="text-[10px] text-muted-foreground">{entry.referenceNo}</p>
                                )}
                              </TableCell>
                              <TableCell className="text-[11px] text-muted-foreground max-w-[150px] truncate">
                                {entry.source}
                              </TableCell>
                              <TableCell className="text-[11px] text-muted-foreground max-w-[150px] truncate">
                                {entry.destination}
                              </TableCell>
                              <TableCell className={`text-right font-semibold text-xs ${entry.direction === 'in' ? 'text-emerald-700' : entry.direction === 'out' ? 'text-red-700' : 'text-cyan-700'}`}>
                                {entry.direction === 'in' ? '+' : entry.direction === 'out' ? '-' : ''}
                                {formatCurrency(entry.amount)}
                              </TableCell>
                              <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {entry.createdBy || '-'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Mobile Card View */}
                  <div className="block md:hidden p-3 space-y-2">
                    {(cashflowData.entries || []).map((entry: CashFlowEntry) => (
                      <div key={entry.id} className="p-3 border rounded-lg space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {entry.direction === 'in' && (
                              <div className="w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center shrink-0">
                                <ArrowUpRight className="w-3.5 h-3.5 text-emerald-600" />
                              </div>
                            )}
                            {entry.direction === 'out' && (
                              <div className="w-7 h-7 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center shrink-0">
                                <ArrowDownLeft className="w-3.5 h-3.5 text-red-600" />
                              </div>
                            )}
                            {entry.direction === 'transfer' && (
                              <div className="w-7 h-7 rounded-full bg-cyan-100 dark:bg-cyan-900 flex items-center justify-center shrink-0">
                                <ArrowLeftRight className="w-3.5 h-3.5 text-cyan-600" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="font-medium text-sm truncate">{entry.description}</p>
                              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <Badge className={`text-[9px] px-1.5 py-0 ${CASHFLOW_CATEGORY_COLORS[entry.category] || ''}`}>
                                  {entry.categoryLabel}
                                </Badge>
                                <span>{formatDateTime(entry.date)}</span>
                              </div>
                            </div>
                          </div>
                          <span className={`font-bold text-sm shrink-0 ${entry.direction === 'in' ? 'text-emerald-700' : entry.direction === 'out' ? 'text-red-700' : 'text-cyan-700'}`}>
                            {entry.direction === 'in' ? '+' : entry.direction === 'out' ? '-' : ''}
                            {formatCurrency(entry.amount)}
                          </span>
                        </div>
                        <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <span>{entry.source}</span>
                          <ArrowRight className="w-2.5 h-2.5" />
                          <span>{entry.destination}</span>
                          {entry.createdBy && (
                            <>·<span>{entry.createdBy}</span></>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Pagination */}
                  {cashflowData.pagination && cashflowData.pagination.totalPages > 1 && (
                    <div className="flex items-center justify-between px-4 py-3 border-t">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        disabled={cashflowPage <= 1}
                        onClick={() => setCashflowPage(p => p - 1)}
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                        Sebelumnya
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {cashflowData.pagination.page} / {cashflowData.pagination.totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        disabled={cashflowPage >= cashflowData.pagination.totalPages}
                        onClick={() => setCashflowPage(p => p + 1)}
                      >
                        Selanjutnya
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="piutang" className="space-y-4">
          <PiutangTab
            receivables={receivables}
            stats={receivableStats}
            userId={user?.id || ''}
            queryClient={queryClient}
            isLoading={receivablesLoading}
          />
        </TabsContent>
        
        {/* Hutang Perusahaan Tab */}
        <TabsContent value="debts" className="space-y-4">
          <CompanyDebtsTab
            debts={debts}
            purchaseDebts={purchaseDebts}
            bankAccounts={bankAccounts}
            cashBoxes={cashBoxes}
            hppInHand={fundBalances.hppInHand}
            profitInHand={fundBalances.profitInHand}
            userId={user?.id || ''}
            queryClient={queryClient}
          />
        </TabsContent>
      </Tabs>

      {/* Delete Bank Account Confirmation Dialog */}
      <AlertDialog open={!!pendingDeleteBank} onOpenChange={(open) => { if (!open) setPendingDeleteBank(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus Rekening Bank</AlertDialogTitle>
            <AlertDialogDescription>
              Yakin ingin menghapus <strong>{pendingDeleteBank?.name}</strong>? Tindakan ini tidak dapat dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() => {
                if (pendingDeleteBank) {
                  deleteBankMutation.mutate(pendingDeleteBank.id);
                  setPendingDeleteBank(null);
                }
              }}
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Cash Box Confirmation Dialog */}
      <AlertDialog open={!!pendingDeleteCashBox} onOpenChange={(open) => { if (!open) setPendingDeleteCashBox(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus Brankas/Kas</AlertDialogTitle>
            <AlertDialogDescription>
              Yakin ingin menghapus <strong>{pendingDeleteCashBox?.name}</strong>? Tindakan ini tidak dapat dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() => {
                if (pendingDeleteCashBox) {
                  deleteCashBoxMutation.mutate(pendingDeleteCashBox.id);
                  setPendingDeleteCashBox(null);
                }
              }}
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}


