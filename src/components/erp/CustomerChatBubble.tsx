'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { getInitials } from '@/lib/erp-helpers';
import { MessageCircle, X, Send, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

interface ChatMessage {
  id: string;
  roomId: string;
  senderType: string;
  senderName: string;
  content: string;
  messageType: string;
  isRead: boolean;
  createdAt: string;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Hari ini';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function shouldShowDate(current: string, prev?: string): boolean {
  if (!prev) return true;
  return new Date(current).toDateString() !== new Date(prev).toDateString();
}

export default function CustomerChatBubble() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Get customer code from URL or localStorage
  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/\/c\/([a-zA-Z0-9]+)/);
    const code = match?.[1] || localStorage.getItem('customer_code');
    if (code) {
      localStorage.setItem('customer_code', code);
      // Fetch customer info
      apiFetch<{ customer?: any }>(`/api/pwa/${code}`).then((data) => {
        if (data.customer?.name) setCustomerName(data.customer.name);
      }).catch(() => {});
    }
  }, []);

  // Poll messages while chat is open
  const fetchMessages = useCallback(async () => {
    if (!isOpen || !roomId) return;
    try {
      const data = await apiFetch(`/api/chat/rooms/${roomId}/messages`);
      setMessages(data.messages || []);
    } catch {}
  }, [isOpen, roomId]);

  useEffect(() => {
    if (!isOpen || !roomId) return;
    setLoading(true);
    fetchMessages().finally(() => setLoading(false));
    // Poll every 5 seconds for new messages
    const interval = setInterval(fetchMessages, 5000);
    return () => clearInterval(interval);
  }, [isOpen, roomId, fetchMessages]);

  // Create room on first open
  const handleOpen = async () => {
    if (!isOpen) {
      setIsOpen(true);
      // Try to create/find room
      try {
        const code = localStorage.getItem('customer_code');
        if (!code) return;
        // First get customer by code
        const custData = await apiFetch<{ customers?: any[] }>(`/api/customers?code=${code}&limit=1`);
        if (custData.customers?.[0]?.id) {
          const roomData = await apiFetch<{ room: any }>('/api/chat/rooms', {
            method: 'POST',
            body: JSON.stringify({ customerId: custData.customers[0].id }),
          });
          if (roomData.room) setRoomId(roomData.room.id);
          if (custData.customers[0].name) setCustomerName(custData.customers[0].name);
        }
      } catch {
        // Room creation will happen on first message
      }
    } else {
      setIsOpen(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      // Ensure room exists
      let currentRoomId = roomId;
      if (!currentRoomId) {
        const code = localStorage.getItem('customer_code');
        if (code) {
          try {
            const custData = await apiFetch<{ customers?: any[] }>(`/api/customers?code=${code}&limit=1`);
            if (custData.customers?.[0]?.id) {
              const roomData = await apiFetch<{ room: any }>('/api/chat/rooms', {
                method: 'POST',
                body: JSON.stringify({ customerId: custData.customers[0].id }),
              });
              if (roomData.room) {
                currentRoomId = roomData.room.id;
                setRoomId(currentRoomId);
              }
            }
          } catch {}
        }
      }

      if (!currentRoomId) {
        // Can't send without room
        return;
      }

      await apiFetch(`/api/chat/rooms/${currentRoomId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: input.trim() }),
      });
      setInput('');
      // Refetch messages
      const data = await apiFetch(`/api/chat/rooms/${currentRoomId}/messages`);
      setMessages(data.messages || []);
    } catch {
      // silent
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const unreadCount = messages.filter((m) => !m.isRead && m.senderType === 'sales').length;

  return (
    <>
      {/* FAB Button */}
      {!isOpen && (
        <button
          onClick={handleOpen}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-lg hover:shadow-xl hover:scale-105 active:scale-95 transition-all duration-200 flex items-center justify-center"
        >
          <MessageCircle className="w-6 h-6" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-[10px] font-bold text-white flex items-center justify-center ring-2 ring-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
          <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 rounded-full ring-2 ring-white animate-pulse" />
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed bottom-0 right-0 z-50 w-full sm:w-[380px] h-full sm:h-[520px] bg-card border-l border-t rounded-tl-2xl flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-300">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b bg-gradient-to-r from-emerald-600 to-emerald-700 text-white shrink-0">
            <Avatar className="w-8 h-8">
              <AvatarFallback className="text-xs bg-white/20 text-white">
                {getInitials(customerName || 'CS')}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">Live Chat</p>
              <p className="text-[11px] text-emerald-100">{customerName ? `Chat dengan ${customerName}` : 'Hubungi kami'}</p>
            </div>
            <button onClick={() => setIsOpen(false)} className="p-1.5 rounded-full hover:bg-white/20 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <p className="text-sm text-muted-foreground">Halo! 👋</p>
                <p className="text-xs text-muted-foreground mt-1">Ada yang bisa kami bantu?</p>
              </div>
            ) : (
              messages.map((msg, i) => {
                const isMine = msg.senderType === 'customer';
                const showDate = shouldShowDate(msg.createdAt, messages[i - 1]?.createdAt);
                return (
                  <div key={msg.id}>
                    {showDate && (
                      <div className="text-center py-1.5">
                        <span className="text-[10px] text-muted-foreground bg-muted/60 px-2.5 py-0.5 rounded-full">
                          {formatDate(msg.createdAt)}
                        </span>
                      </div>
                    )}
                    <div className={cn('flex gap-2', isMine ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'max-w-[260px] rounded-xl px-3 py-2 text-sm',
                          isMine
                            ? 'bg-emerald-600 text-white rounded-br-sm'
                            : 'bg-muted rounded-bl-sm',
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                        <p className={cn('text-[10px] mt-0.5', isMine ? 'text-emerald-200' : 'text-muted-foreground')}>
                          {formatTime(msg.createdAt)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 p-2 border-t safe-bottom">
            <div className="flex items-center gap-2">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Ketik pesan..."
                className="flex-1 h-9 text-sm"
                disabled={sending}
              />
              <Button
                size="icon"
                className="h-9 w-9 bg-emerald-600 hover:bg-emerald-700 shrink-0"
                onClick={handleSend}
                disabled={sending || !input.trim()}
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
