'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/erp-helpers';
import {
  Building2,
  CircleDollarSign,
  TrendingUp,
  AlertTriangle,
  Landmark,
  Plus,
  Minus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogFooter } from '@/components/ui/dialog';

export function PoolAdjustForm({
  totalPhysical,
  currentHpp,
  currentProfit,
  currentInvestorFund = 0,
  onSave,
  isSaving,
}: {
  totalPhysical: number;
  currentHpp: number;
  currentProfit: number;
  currentInvestorFund?: number;
  onSave: (data: { hppPaidBalance?: number; profitPaidBalance?: number; investorFund?: number; totalPhysical: number }) => void;
  isSaving: boolean;
}) {
  const [editField, setEditField] = useState<'hpp' | 'profit'>('hpp');
  const [hppValue, setHppValue] = useState(currentHpp);
  const [profitValue, setProfitValue] = useState(currentProfit);
  const [investorValue, setInvestorValue] = useState(currentInvestorFund);

  // Total pool = HPP + Profit + Dana Lain-lain
  const totalPool = hppValue + profitValue + investorValue;
  const poolFromOps = totalPool - investorValue; // HPP + Profit

  const maxOpsValue = Math.max(0, totalPhysical - investorValue);
  const [inputValue, setInputValue] = useState(0);
  const [inputError, setInputError] = useState('');

  const handleHppChange = (val: number) => {
    setInputValue(val);
    if (val > maxOpsValue) {
      setInputError('Nilai melebihi batas maksimum');
    } else {
      setInputError('');
    }
    const clamped = Math.max(0, Math.min(val, maxOpsValue));
    setHppValue(clamped);
    setProfitValue(Math.max(0, Math.round(maxOpsValue - clamped)));
  };

  const handleProfitChange = (val: number) => {
    setInputValue(val);
    if (val > maxOpsValue) {
      setInputError('Nilai melebihi batas maksimum');
    } else {
      setInputError('');
    }
    const clamped = Math.max(0, Math.min(val, maxOpsValue));
    setProfitValue(clamped);
    setHppValue(Math.max(0, Math.round(maxOpsValue - clamped)));
  };

  const handleInvestorChange = (val: number) => {
    const clamped = Math.max(0, val);
    setInvestorValue(clamped);
  };

  const handleSave = () => {
    onSave({
      hppPaidBalance: hppValue,
      profitPaidBalance: profitValue,
      investorFund: investorValue,
      totalPhysical,
    });
  };

  const canSave = !inputError && (hppValue >= 0 || profitValue >= 0);
  const hppPercent = totalPool > 0 ? ((hppValue / totalPool) * 100).toFixed(1) : '0.0';
  const profitPercent = totalPool > 0 ? ((profitValue / totalPool) * 100).toFixed(1) : '0.0';
  const investorPercent = totalPool > 0 ? ((investorValue / totalPool) * 100).toFixed(1) : '0.0';

  return (
    <div className="space-y-4">
      {/* Total Physical Funds (read-only) */}
      <div className="p-3 rounded-lg bg-muted">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Total Dana Fisik (Rekening + Brankas + Kurir)</p>
            <p className="text-xl font-bold">{formatCurrency(totalPhysical)}</p>
          </div>
          <Building2 className="w-6 h-6 text-muted-foreground" />
        </div>
      </div>

      {/* Logic explanation */}
      <div className="p-2.5 rounded-lg bg-blue-50 dark:bg-blue-950 text-xs text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
        <p className="font-semibold mb-1">💡 Logika Komposisi Dana:</p>
        <p><strong>Total Pool = HPP + Profit + Dana Lain-lain</strong></p>
        <p className="mt-0.5">HPP + Profit di-auto-kalkulasi dari Total Fisik. Dana Lain-lain bersifat <strong>additive</strong> (menambah total).</p>
      </div>

      {/* Dana Lain-lain — independent field */}
      <div className="p-3 rounded-xl border-2 border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/30">
        <div className="flex items-center gap-2 mb-2">
          <Landmark className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">Dana Lain-lain</span>
          <span className="ml-auto text-xs text-amber-500 bg-amber-100 dark:bg-amber-900 px-2 py-0.5 rounded-full">
            {investorPercent}%
          </span>
        </div>
        <p className="text-[10px] text-amber-600/70 dark:text-amber-400/70 mb-2">Dana tambahan dari investor, pinjaman, atau sumber lain (bersifat tambahan, tidak dikurangi dari HPP/Profit)</p>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">Rp</span>
          <Input
            type="number"
            className="pl-10 text-base font-semibold"
            value={investorValue || ''}
            onChange={(e) => handleInvestorChange(parseInt(e.target.value) || 0)}
            min={0}
            placeholder="0"
          />
        </div>
      </div>

      {/* Toggle: edit HPP or Profit */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => { setEditField('hpp'); handleHppChange(hppValue); }}
          className={`p-3 rounded-lg border-2 text-left transition-all ${
            editField === 'hpp' ? 'border-purple-500 bg-purple-50 dark:bg-purple-950' : 'border-muted hover:border-purple-300'
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <CircleDollarSign className="w-4 h-4 text-purple-600" />
            <span className="text-xs font-semibold">Edit HPP</span>
          </div>
          <p className="text-lg font-bold text-purple-700 dark:text-purple-300">{formatCurrency(hppValue)}</p>
          <p className="text-[10px] text-muted-foreground">{hppPercent}% dari total</p>
        </button>

        <button
          type="button"
          onClick={() => { setEditField('profit'); handleProfitChange(profitValue); }}
          className={`p-3 rounded-lg border-2 text-left transition-all ${
            editField === 'profit' ? 'border-teal-500 bg-teal-50 dark:bg-teal-950' : 'border-muted hover:border-teal-300'
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp className="w-4 h-4 text-teal-600" />
            <span className="text-xs font-semibold">Edit Profit</span>
          </div>
          <p className="text-lg font-bold text-teal-700 dark:text-teal-300">{formatCurrency(profitValue)}</p>
          <p className="text-[10px] text-muted-foreground">{profitPercent}% dari total</p>
        </button>
      </div>

      {/* Input field */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">
            {editField === 'hpp' ? 'HPP Sudah Terbayar' : 'Profit Sudah Terbayar'}
          </Label>
          <span className="text-xs text-muted-foreground">
            Maks: {formatCurrency(maxOpsValue)}
          </span>
        </div>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">Rp</span>
          <Input
            type="number"
            className={cn("pl-10 text-lg font-semibold", inputError && "border-red-500 focus-visible:ring-red-500")}
            value={editField === 'hpp' ? hppValue || '' : profitValue || ''}
            onChange={(e) => {
              const val = parseInt(e.target.value) || 0;
              if (editField === 'hpp') handleHppChange(val);
              else handleProfitChange(val);
            }}
            min={0}
            max={maxOpsValue}
          />
        </div>
        {inputError && (
          <p className="text-xs text-red-500 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {inputError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {editField === 'hpp'
            ? `→ Profit otomatis: ${formatCurrency(profitValue)}`
            : `→ HPP otomatis: ${formatCurrency(hppValue)}`
          }
        </p>
      </div>

      {/* Summary */}
      <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
        <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-1">📊 Ringkasan Komposisi Dana</p>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">HPP Sudah Terbayar</span>
            <span className="font-semibold text-purple-700">{formatCurrency(hppValue)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Profit Sudah Terbayar</span>
            <span className="font-semibold text-teal-700">{formatCurrency(profitValue)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Dana Lain-lain</span>
            <span className="font-semibold text-amber-700">{formatCurrency(investorValue)}</span>
          </div>
          <div className="border-t border-emerald-200 dark:border-emerald-800 pt-1 mt-1 flex justify-between">
            <span className="font-semibold">Total Pool</span>
            <span className="font-bold text-emerald-700">{formatCurrency(totalPool)}</span>
          </div>
        </div>
      </div>

      {/* Visual preview bar — 3 segments */}
      <div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
          <span>HPP {hppPercent}%</span>
          <span>Profit {profitPercent}%</span>
          <div className="flex-1" />
          <span>Lain-lain {investorPercent}%</span>
        </div>
        <div className="h-3 rounded-full overflow-hidden bg-muted flex">
          <div className="bg-purple-500 transition-all duration-300" style={{ width: `${hppPercent}%` }} />
          <div className="bg-teal-500 transition-all duration-300" style={{ width: `${profitPercent}%` }} />
          <div className="bg-amber-400 transition-all duration-300" style={{ width: `${investorPercent}%` }} />
        </div>
      </div>

      {/* Validation warning */}
      {totalPool > totalPhysical && (
        <div className="flex items-center gap-1.5 text-xs text-red-500">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>Total pool ({formatCurrency(totalPool)}) melebihi dana fisik ({formatCurrency(totalPhysical)})</span>
        </div>
      )}

      {/* Action */}
      <DialogFooter>
        <Button
          onClick={handleSave}
          disabled={isSaving || !!inputError}
          className="w-full bg-purple-600 hover:bg-purple-700"
        >
          {isSaving ? 'Menyimpan...' : 'Simpan Komposisi Dana'}
        </Button>
      </DialogFooter>
    </div>
  );
}
