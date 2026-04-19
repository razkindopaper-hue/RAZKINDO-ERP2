'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-client';
import { Bot, Send, X, Loader2, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const QUICK_ACTIONS = [
  { label: 'Penjualan hari ini', query: 'Bagaimana penjualan hari ini? Berikan ringkasan lengkap.' },
  { label: 'Stok rendah', query: 'Produk apa saja yang stoknya rendah dan perlu segera di-restock?' },
  { label: 'Analisa keuangan', query: 'Berikan analisa keuangan komprehensif: cash flow, profit, tren penjualan.' },
  { label: 'Piutang', query: 'Berikan daftar piutang aktif, overdue, dan rekomendasi penagihan.' },
];

export default function ZaiAdminChat() {
  const { user } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 300);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Welcome message
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      setMessages([{
        role: 'assistant',
        content: 'Halo! 👋 Saya **AI Assistant Razkindo**.\n\nSaya bisa membantu:\n- 📊 Analisis penjualan & keuangan\n- 📦 Informasi stok produk\n- 💡 Rekomendasi bisnis\n- 📋 Status piutang\n\nKlik tombol cepat di bawah atau ketik pertanyaan!',
      }]);
    }
  }, [isOpen, messages.length]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;
    const msg = text.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    setLoading(true);

    try {
      const data = await apiFetch<{ success: boolean; reply: string }>('/api/ai/zai-chat', {
        method: 'POST',
        body: JSON.stringify({ message: msg, history: messages }),
      });
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.success ? data.reply : '⚠️ Gagal mendapatkan respons. Coba lagi.',
      }]);
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '⚠️ Koneksi gagal. Periksa jaringan internet Anda.',
      }]);
    } finally {
      setLoading(false);
    }
  }, [loading, messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  // Don't render for non-super_admin
  if (user?.role !== 'super_admin') return null;

  return (
    <>
      {/* Floating FAB */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-24 right-4 z-[60] lg:bottom-6 w-14 h-14 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/30 flex items-center justify-center hover:scale-110 hover:shadow-xl active:scale-95 transition-all duration-200 group"
          title="AI Assistant"
        >
          <Bot className="w-6 h-6 transition-transform group-hover:scale-110" />
          <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-20" />
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <>
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[59] sm:hidden" onClick={() => setIsOpen(false)} />
          <div className="fixed z-[60] inset-0 sm:inset-auto sm:bottom-24 sm:right-4 sm:top-auto lg:bottom-6 sm:w-[400px] sm:h-[560px] sm:rounded-2xl bg-background sm:border sm:border-border/50 sm:shadow-2xl flex flex-col animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 sm:slide-in-from-right-4 duration-300 ease-out">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-4 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 text-white sm:rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">AI Assistant</h3>
                  <p className="text-[11px] text-white/80">Powered by Z.ai</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} className="h-8 w-8 text-white/80 hover:text-white hover:bg-white/10">
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-4">
                {messages.map((msg, i) => (
                  <div key={i} className={cn('flex gap-2.5', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
                    <Avatar className={cn('w-8 h-8 shrink-0', msg.role === 'user' ? 'bg-gray-500' : 'bg-gradient-to-br from-emerald-500 to-teal-600')}>
                      <AvatarFallback className="text-[11px] font-bold text-white">{msg.role === 'user' ? 'U' : 'AI'}</AvatarFallback>
                    </Avatar>
                    <div className={cn(
                      'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words',
                      msg.role === 'user'
                        ? 'bg-muted text-foreground rounded-br-md'
                        : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-100 border border-emerald-200/60 dark:border-emerald-800/40 rounded-bl-md [&>strong]:font-semibold [&>strong]:text-emerald-700 dark:[&>strong]:text-emerald-300',
                    )}>
                      {msg.role === 'user' ? msg.content : renderMarkdown(msg.content)}
                    </div>
                  </div>
                ))}

                {/* Typing indicator */}
                {loading && (
                  <div className="flex gap-2.5">
                    <Avatar className="w-8 h-8 shrink-0 bg-gradient-to-br from-emerald-500 to-teal-600">
                      <AvatarFallback className="text-[11px] font-bold text-white">AI</AvatarFallback>
                    </Avatar>
                    <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-800/40 rounded-2xl rounded-bl-md px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 bg-emerald-500/60 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-2 h-2 bg-emerald-500/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-2 h-2 bg-emerald-500/60 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            </ScrollArea>

            {/* Quick Actions */}
            <div className="shrink-0 px-3 py-2 border-t border-border/40">
              <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
                {QUICK_ACTIONS.map(a => (
                  <button
                    key={a.label}
                    onClick={() => sendMessage(a.query)}
                    disabled={loading}
                    className="flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40 hover:bg-emerald-100 dark:hover:bg-emerald-950/60 active:scale-95 transition-all disabled:opacity-50"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} className="shrink-0 flex items-center gap-2 px-3 py-3 border-t border-border/40 sm:rounded-b-2xl">
              <Input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Tanya apa saja..."
                disabled={loading}
                className="flex-1 h-10 rounded-full bg-muted/50 border-0 text-sm focus-visible:ring-1 focus-visible:ring-emerald-500/50"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || loading}
                className="h-10 w-10 rounded-full shrink-0 bg-gradient-to-br from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-sm disabled:opacity-40 transition-all"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </form>
          </div>
        </>
      )}
    </>
  );
}

function BoldText({ text }: { text: string }) {
  // Safe markdown-like rendering: split by **bold** markers and render as <strong> tags
  const parts = text.split(/(\*\*.*?\*\*)/);
  return <>{parts.map((p, j) => /^\*\*.*\*\*$/.test(p) ? <strong key={j}>{p.slice(2, -2)}</strong> : p)}</>;
}

function renderMarkdown(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    const isBullet = /^[\s]*[-•]\s/.test(line);
    const isNum = /^[\s]*\d+\.\s/.test(line);
    const isHr = /^[-*_]{3,}$/.test(line);

    if (isHr) return <hr key={i} className="border-emerald-200/40 dark:border-emerald-800/40 my-2" />;
    if (isBullet) return <div key={i} className="flex gap-1.5 ml-1"><span className="text-emerald-500 shrink-0">•</span><BoldText text={line.replace(/^[\s]*[-•]\s*/, '')} /></div>;
    if (isNum) { const n = line.match(/^[\s]*(\d+)\./)?.[1]; return <div key={i} className="flex gap-1.5 ml-1"><span className="text-emerald-500 font-semibold shrink-0 min-w-[1.2em]">{n}.</span><BoldText text={line.replace(/^[\s]*\d+\.\s*/, '')} /></div>; }
    if (!line.trim()) return <br key={i} />;
    return <span key={i}><BoldText text={line} /></span>;
  });
}
