'use client';

import dynamic from 'next/dynamic';

// Thin client component shell — the entire ERP app is lazy-loaded via
// AppShell. This keeps the initial webpack compile tiny so the dev
// server doesn't OOM when compiling 30K+ lines of ERP modules.
const AppShell = dynamic(() => import('@/components/erp/AppShell'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        <div className="w-10 h-10 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-sm text-muted-foreground">Memuat Razkindo ERP...</p>
      </div>
    </div>
  ),
});

export default function Home() {
  return <AppShell />;
}
