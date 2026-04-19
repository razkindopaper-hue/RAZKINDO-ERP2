'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-client';
import { Bot, Send, X, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
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

  // Inject slideUp keyframe animation once
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById('zai-chat-anim')) return;
    const s = document.createElement('style');
    s.id = 'zai-chat-anim';
    s.textContent = `@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(s);
  }, []);

  // Welcome message
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      setMessages([{
        role: 'assistant',
        content: 'Halo! 👋 Saya **AI Assistant Razkindo**.\n\nSaya bisa membantu:\n- 📊 Analisis penjualan & keuangan\n- 📦 Informasi stok produk\n- 💡 Rekomendasi bisnis\n- 📋 Status piutang\n\nKlik tombol cepat di bawah atau ketik pertanyaan!',
        timestamp: new Date(),
      }]);
    }
  }, [isOpen, messages.length]);

  const clearChat = useCallback(() => {
    setMessages([]);
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;
    const msg = text.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: msg, timestamp: new Date() }]);
    setLoading(true);

    try {
      const data = await apiFetch<{ success: boolean; reply: string }>('/api/ai/zai-chat', {
        method: 'POST',
        body: JSON.stringify({ message: msg, history: messages }),
      });
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.success ? data.reply : '⚠️ Gagal mendapatkan respons. Coba lagi.',
        timestamp: new Date(),
      }]);
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '⚠️ Koneksi gagal. Periksa jaringan internet Anda.',
        timestamp: new Date(),
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
          className="fixed bottom-24 right-4 z-[60] lg:bottom-6 flex items-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 pl-3 pr-4 py-2.5 text-white shadow-lg shadow-emerald-500/25 hover:shadow-xl hover:shadow-emerald-500/30 active:scale-[0.97] transition-all duration-200"
          title="AI Assistant"
        >
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-white/20">
            <Bot className="w-4.5 h-4.5" />
            <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-white" />
            </span>
          </span>
          <span className="text-sm font-semibold">AI Assistant</span>
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <>
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[59] sm:hidden" onClick={() => setIsOpen(false)} />
          <div className="fixed z-[60] inset-0 sm:inset-auto sm:right-4 sm:bottom-24 lg:bottom-6 sm:w-[420px] sm:h-[580px] flex flex-col overflow-hidden rounded-none sm:rounded-2xl border border-border/50 bg-background shadow-2xl sm:shadow-2xl" style={{ animation: 'slideUp 0.25s ease-out' }}>
            {/* Header */}
            <div className="shrink-0 bg-gradient-to-r from-emerald-600 to-teal-600 sm:rounded-t-2xl">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/15 ring-2 ring-white/20">
                    <Sparkles className="w-5 h-5" />
                    <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-300" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-[15px] leading-tight">AI Assistant</h3>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                      <p className="text-[11px] text-white/80">Online · Powered by Z.ai</p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={clearChat} className="h-8 w-8 text-white/70 hover:text-white hover:bg-white/10" title="Hapus chat">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  <Separator orientation="vertical" className="mx-0.5 h-4 bg-white/20" />
                  <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} className="h-8 w-8 text-white/70 hover:text-white hover:bg-white/10">
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 overflow-hidden">
              <div className="px-4 py-4 space-y-5">
                {messages.map((msg, i) => (
                  <div key={i} className={cn('flex gap-2', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
                    <Avatar className={cn(
                      'w-7 h-7 shrink-0 mt-1',
                      msg.role === 'user'
                        ? 'bg-primary'
                        : 'bg-gradient-to-br from-emerald-500 to-teal-600'
                    )}>
                      <AvatarFallback className="text-[10px] font-bold text-white">
                        {msg.role === 'user' ? 'U' : 'AI'}
                      </AvatarFallback>
                    </Avatar>
                    <div className={cn('flex flex-col gap-1 min-w-0', msg.role === 'user' && 'items-end')}>
                      <div className={cn(
                        'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words shadow-sm',
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground rounded-br-sm'
                          : 'bg-muted text-foreground rounded-bl-sm border border-border/60',
                      )}>
                        {msg.role === 'user' ? msg.content : renderMarkdown(msg.content)}
                      </div>
                      {msg.timestamp && (
                        <span className="text-[10px] text-muted-foreground px-1">
                          {msg.timestamp.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>
                ))}

                {/* Typing indicator */}
                {loading && (
                  <div className="flex gap-2">
                    <Avatar className="w-7 h-7 shrink-0 mt-1 bg-gradient-to-br from-emerald-500 to-teal-600">
                      <AvatarFallback className="text-[10px] font-bold text-white">AI</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col gap-1">
                      <div className="bg-muted rounded-2xl rounded-bl-sm border border-border/60 px-4 py-3 shadow-sm">
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                      <span className="text-[10px] text-muted-foreground px-1">Mengetik...</span>
                    </div>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            </ScrollArea>

            {/* Quick Actions */}
            {messages.length > 0 && (
              <div className="shrink-0 px-3 py-2 border-t border-border/40">
                <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
                  {QUICK_ACTIONS.map(a => (
                    <Button
                      key={a.label}
                      variant="outline"
                      size="sm"
                      onClick={() => sendMessage(a.query)}
                      disabled={loading}
                      className="shrink-0 rounded-full text-xs font-medium border-emerald-200/60 bg-emerald-50/50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-950/50 dark:hover:text-emerald-300 h-7 px-2.5 active:scale-95 transition-all"
                    >
                      {a.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* Input */}
            <form onSubmit={handleSubmit} className="shrink-0 border-t border-border/40 px-3 py-3 sm:rounded-b-2xl">
              <div className="flex items-center gap-2">
                <Input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Tanya tentang penjualan, stok, keuangan..."
                  disabled={loading}
                  className="flex-1 h-10 rounded-full border-border/60 bg-muted/40 text-sm focus-visible:ring-1 focus-visible:ring-emerald-500/40 focus-visible:border-emerald-500/40"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!input.trim() || loading}
                  className="h-10 w-10 shrink-0 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-md shadow-emerald-500/20 disabled:opacity-40 transition-all"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
            </form>
          </div>
        </>
      )}
    </>
  );
}

function BoldText({ text }: { text: string }) {
  const parts = text.split(/(\*\*.*?\*\*)/);
  return <>{parts.map((p, j) => /^\*\*.*\*\*$/.test(p) ? <strong key={j}>{p.slice(2, -2)}</strong> : p)}</>;
}

function renderMarkdown(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    const isBullet = /^[\s]*[-•]\s/.test(line);
    const isNum = /^[\s]*\d+\.\s/.test(line);
    const isHr = /^[-*_]{3,}$/.test(line);

    if (isHr) return <hr key={i} className="border-border/30 my-2" />;
    if (isBullet) return <div key={i} className="flex gap-1.5 ml-0.5"><span className="text-primary shrink-0 text-xs mt-px">•</span><BoldText text={line.replace(/^[\s]*[-•]\s*/, '')} /></div>;
    if (isNum) { const n = line.match(/^[\s]*(\d+)\./)?.[1]; return <div key={i} className="flex gap-1.5 ml-0.5"><span className="text-primary font-semibold shrink-0 min-w-[1.2em] text-xs mt-px">{n}.</span><BoldText text={line.replace(/^[\s]*\d+\.\s*/, '')} /></div>; }
    if (!line.trim()) return <br key={i} />;
    return <span key={i}><BoldText text={line} /></span>;
  });
}
