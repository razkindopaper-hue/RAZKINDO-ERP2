'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { getInitials } from '@/lib/erp-helpers';
import {
  MessageCircle, Search, Send, X, ChevronLeft, User, Loader2, Megaphone,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import dynamic from 'next/dynamic';

const BroadcastDialog = dynamic(() => import('./BroadcastDialog'), { ssr: false });

// ==================== TYPES ====================
interface ChatRoom {
  id: string;
  customerId: string;
  salesId: string;
  unitId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  customerUnread: number;
  salesUnread: number;
  isActive: boolean;
  customer: { id: string; name: string; phone?: string; code?: string };
  sales?: { id: string; name: string };
}

interface ChatMessage {
  id: string;
  roomId: string;
  senderType: string;
  senderId: string;
  senderName: string;
  content: string;
  messageType: string;
  isRead: boolean;
  createdAt: string;
}

// ==================== HELPER ====================
function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
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

// ==================== MAIN COMPONENT ====================
export default function SalesChatPanel() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch rooms
  const { data: roomsData, isLoading: roomsLoading } = useQuery<{ rooms: ChatRoom[] }>({
    queryKey: ['chat-rooms'],
    queryFn: () => apiFetch('/api/chat/rooms'),
    refetchInterval: 10_000,
    enabled: !!user,
  });
  const rooms = roomsData?.rooms || [];

  // Fetch messages
  const { data: messagesData, isLoading: messagesLoading } = useQuery<{ messages: ChatMessage[] }>({
    queryKey: ['chat-messages', selectedRoomId],
    queryFn: () => apiFetch(`/api/chat/rooms/${selectedRoomId}/messages`),
    refetchInterval: 5000,
    enabled: !!selectedRoomId,
  });
  const messages = messagesData?.messages || [];

  // Send message mutation
  const sendMutation = useMutation({
    mutationFn: (data: { content: string; messageType?: string }) =>
      apiFetch(`/api/chat/rooms/${selectedRoomId}/messages`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      setInput('');
      queryClient.invalidateQueries({ queryKey: ['chat-messages', selectedRoomId] });
      queryClient.invalidateQueries({ queryKey: ['chat-rooms'] });
    },
  });

  const handleSend = () => {
    if (!input.trim() || sending || !selectedRoomId) return;
    setSending(true);
    sendMutation.mutate(
      { content: input.trim() },
      { onSettled: () => setSending(false) },
    );
  };

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, messagesLoading]);

  // Focus input on room select
  useEffect(() => {
    if (selectedRoomId) inputRef.current?.focus();
  }, [selectedRoomId]);

  const filteredRooms = search
    ? rooms.filter((r) => r.customer.name.toLowerCase().includes(search.toLowerCase()))
    : rooms;

  const selectedRoom = rooms.find((r) => r.id === selectedRoomId);
  const totalUnread = rooms.reduce((sum, r) => sum + r.salesUnread, 0);

  // ==================== MOBILE: Room selected ====================
  const isMobileSelected = selectedRoomId && typeof window !== 'undefined' && window.innerWidth < 768;

  if (isMobileSelected) {
    return (
      <>
      <div className="flex flex-col h-full bg-background">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b bg-card/80 backdrop-blur-xl shrink-0 safe-top">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedRoomId(null)}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Avatar className="w-7 h-7">
            <AvatarFallback className="text-xs bg-emerald-100 text-emerald-700">
              {getInitials(selectedRoom?.customer?.name || 'C')}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{selectedRoom?.customer?.name}</p>
            {selectedRoom?.customer?.phone && (
              <p className="text-[11px] text-muted-foreground">{selectedRoom.customer.phone}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-amber-600 hover:text-amber-700"
            onClick={() => setBroadcastOpen(true)}
            title="Broadcast"
          >
            <Megaphone className="w-4 h-4" />
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {messagesLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {messages.map((msg, i) => {
            const isMine = msg.senderType === 'sales';
            const showDate = shouldShowDate(msg.createdAt, messages[i - 1]?.createdAt);
            return (
              <div key={msg.id}>
                {showDate && (
                  <div className="text-center py-2">
                    <span className="text-[11px] text-muted-foreground bg-muted/60 px-3 py-1 rounded-full">
                      {formatDate(msg.createdAt)}
                    </span>
                  </div>
                )}
                <div className={cn('flex gap-2', isMine ? 'justify-end' : 'justify-start')}>
                  {!isMine && (
                    <Avatar className="w-7 h-7 shrink-0 mt-auto">
                      <AvatarFallback className="text-[10px] bg-gray-100 text-gray-600">
                        {getInitials(msg.senderName)}
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div className={cn('max-w-[75%] rounded-2xl px-3 py-2 text-sm', isMine ? 'bg-emerald-600 text-white rounded-br-sm' : 'bg-muted rounded-bl-sm')}>
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    <p className={cn('text-[10px] mt-1', isMine ? 'text-emerald-200' : 'text-muted-foreground')}>{formatTime(msg.createdAt)}</p>
                  </div>
                </div>
              </div>
            );
          })}
          {!messagesLoading && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <MessageCircle className="w-12 h-12 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">Mulai percakapanan</p>
              <p className="text-xs text-muted-foreground">Kirim pesan untuk memulai chat</p>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 p-2 border-t bg-card/50 safe-bottom">
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              placeholder="Ketik pesan..."
              className="flex-1 h-10 text-sm"
              disabled={sending}
            />
            <Button size="icon" className="h-10 w-10 shrink-0 bg-emerald-600 hover:bg-emerald-700" onClick={handleSend} disabled={sending || !input.trim()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>
      <BroadcastDialog open={broadcastOpen} onOpenChange={setBroadcastOpen} />
      </>
    );
  }

  // ==================== DESKTOP: Room List + Messages ====================
  return (
    <>
    <div className="flex h-full gap-0 rounded-xl border bg-card overflow-hidden">
      {/* Room List */}
      <div className="w-72 lg:w-80 shrink-0 flex flex-col border-r">
        <div className="px-3 py-2.5 border-b space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-emerald-600" />
              Chat Pelanggan
              {totalUnread > 0 && <Badge className="bg-emerald-600 text-[10px] px-1.5 h-5">{totalUnread}</Badge>}
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
              onClick={() => setBroadcastOpen(true)}
              title="Broadcast Pesan"
            >
              <Megaphone className="w-4 h-4" />
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari pelanggan..."
              className="pl-8 h-8 text-xs"
            />
          </div>
        </div>

        <ScrollArea className="flex-1">
          {roomsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredRooms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <User className="w-10 h-10 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">{search ? 'Tidak ditemukan' : 'Belum ada chat'}</p>
              <p className="text-xs text-muted-foreground mt-1">Chat akan muncul saat pelanggan mengirim pesan</p>
            </div>
          ) : (
            <div className="divide-y">
              {filteredRooms.map((room) => {
                const isActive = selectedRoomId === room.id;
                const unread = room.salesUnread;
                return (
                  <button
                    key={room.id}
                    onClick={() => setSelectedRoomId(room.id)}
                    className={cn(
                      'w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                      isActive && 'bg-emerald-50 dark:bg-emerald-950/20',
                    )}
                  >
                    <Avatar className="w-9 h-9 shrink-0 mt-0.5">
                      <AvatarFallback className="text-xs bg-emerald-100 text-emerald-700">
                        {getInitials(room.customer.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium truncate">{room.customer.name}</p>
                        {unread > 0 && <span className="w-5 h-5 rounded-full bg-emerald-600 text-[10px] font-bold text-white flex items-center justify-center">{unread}</span>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {room.lastMessage || 'Belum ada pesan'}
                      </p>
                      {room.lastMessageAt && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">{formatTime(room.lastMessageAt)}</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Messages */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedRoomId && selectedRoom ? (
          <>
            {/* Chat Header */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-card/50 shrink-0">
              <Avatar className="w-8 h-8">
                <AvatarFallback className="text-xs bg-emerald-100 text-emerald-700">
                  {getInitials(selectedRoom.customer.name)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{selectedRoom.customer.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {selectedRoom.customer.phone || selectedRoom.customer.code || 'Customer'}
                </p>
              </div>
              <Separator orientation="vertical" className="h-6 mx-1" />
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedRoomId(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 p-4">
              {messagesLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg, i) => {
                    const isMine = msg.senderType === 'sales';
                    const showDate = shouldShowDate(msg.createdAt, messages[i - 1]?.createdAt);
                    return (
                      <div key={msg.id}>
                        {showDate && (
                          <div className="text-center py-2">
                            <span className="text-[11px] text-muted-foreground bg-muted/60 px-3 py-1 rounded-full">
                              {formatDate(msg.createdAt)}
                            </span>
                          </div>
                        )}
                        <div className={cn('flex gap-2.5', isMine ? 'justify-end' : 'justify-start')}>
                          {!isMine && (
                            <Avatar className="w-7 h-7 shrink-0 mt-auto">
                              <AvatarFallback className="text-[10px] bg-gray-100 text-gray-600">
                                {getInitials(msg.senderName)}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <div
                            className={cn(
                              'max-w-[320px] rounded-2xl px-3.5 py-2.5 shadow-sm',
                              isMine
                                ? 'bg-emerald-600 text-white rounded-br-sm'
                                : 'bg-muted rounded-bl-sm',
                            )}
                          >
                            <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                            <p className={cn('text-[10px] mt-1', isMine ? 'text-emerald-200' : 'text-muted-foreground')}>
                              {formatTime(msg.createdAt)}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {!messagesLoading && messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                      <MessageCircle className="w-14 h-14 text-muted-foreground/20 mb-4" />
                      <p className="text-sm font-medium text-muted-foreground">Mulai percakapanan</p>
                      <p className="text-xs text-muted-foreground mt-1">Kirim pesan untuk memulai chat dengan pelanggan</p>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </ScrollArea>

            {/* Input */}
            <div className="shrink-0 p-3 border-t">
              <div className="flex items-center gap-2">
                <Input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="Ketik pesan..."
                  className="flex-1"
                  disabled={sending}
                />
                <Button
                  size="icon"
                  className="bg-emerald-600 hover:bg-emerald-700 shrink-0"
                  onClick={handleSend}
                  disabled={sending || !input.trim()}
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <div className="w-20 h-20 rounded-full bg-emerald-50 dark:bg-emerald-950/20 flex items-center justify-center mb-4">
              <MessageCircle className="w-10 h-10 text-emerald-500/50" />
            </div>
            <h3 className="text-lg font-semibold text-muted-foreground">Chat Pelanggan</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Pilih percakapanan dari daftar untuk mulai chatting dengan pelanggan
            </p>
          </div>
        )}
      </div>
    </div>

    {/* Broadcast Dialog */}
    <BroadcastDialog open={broadcastOpen} onOpenChange={setBroadcastOpen} />
    </>);
}
