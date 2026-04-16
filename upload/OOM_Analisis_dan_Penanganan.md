# Analisis OOM, Bug, dan Langkah Penanganan
**Proyek:** ERP Next.js + Supabase  
**Tanggal Analisis:** 17 April 2025  
**Basis Kode:** `Arsip17April00_54.tar`

---

## Daftar Isi

1. [Ringkasan Eksekutif](#1-ringkasan-eksekutif)
2. [Penyebab OOM yang Teridentifikasi](#2-penyebab-oom-yang-teridentifikasi)
3. [Bug yang Ditemukan](#3-bug-yang-ditemukan)
4. [Perbaikan yang Sudah Diterapkan (Worklog)](#4-perbaikan-yang-sudah-diterapkan-worklog)
5. [Langkah Penanganan Lanjutan](#5-langkah-penanganan-lanjutan)
6. [Konfigurasi Runtime yang Disarankan](#6-konfigurasi-runtime-yang-disarankan)
7. [Monitoring & Deteksi Dini](#7-monitoring--deteksi-dini)
8. [Checklist Deployment](#8-checklist-deployment)

---

## 1. Ringkasan Eksekutif

Server dev mengalami **Out of Memory (OOM) crash** berulang akibat beberapa modul berat yang diinisialisasi secara agresif saat startup. Kombinasi dari eager singleton, polling loop yang tidak efisien, batas buffer yang terlalu besar, dan kueri DB saat boot menyebabkan heap V8 meledak sebelum server sempat melayani request.

**Severity:** KRITIS — server crash sebelum production-ready  
**Root Cause Utama:** Eager initialization + polling 10ms di `concurrency-queue` + histogram 10.000 sampel di `performance-monitor`

---

## 2. Penyebab OOM yang Teridentifikasi

### 2.1 Eager Singleton Initialization (HIGH)

**File:** `src/lib/performance-monitor.ts`, `src/lib/concurrency-queue.ts`, `src/lib/batch-optimizer.ts`

**Masalah:**  
Ketiga modul ini sebelumnya membuat instance langsung saat modul di-import (eager), bukan saat pertama kali digunakan. Karena Next.js me-resolve semua import pada startup, ketiga objek berat ini dibuat sekaligus di awal.

```typescript
// SEBELUM (buruk) — instance dibuat saat module load
export const perfMonitor = new PerformanceMonitor();  // langsung allocate semua buffer
export const concurrencyManager = ConcurrencyManager.getInstance(); // start timer segera
export const batchOptimizer = new BatchOptimizer(); // allocate Map & struktur data
```

**Dampak:** Heap spike besar (~50–150 MB) saat server baru mulai, sebelum ada request masuk.

**Perbaikan:** Ganti dengan Proxy-based lazy singleton.

```typescript
// SESUDAH (benar) — instance hanya dibuat saat pertama kali diakses
let _perfMonitor: PerformanceMonitor | null = null;
export const perfMonitor = new Proxy({} as PerformanceMonitor, {
  get(_target, prop, receiver) {
    if (!_perfMonitor) _perfMonitor = new PerformanceMonitor();
    return Reflect.get(_perfMonitor, prop, receiver);
  },
});
```

---

### 2.2 Polling Loop 10ms di ConcurrencyQueue (CRITICAL)

**File:** `src/lib/concurrency-queue.ts` → `waitForCompletion()`

**Masalah (versi lama):**  
Setiap operasi yang di-enqueue membuat `setInterval` dengan interval 10ms untuk menunggu hasil. Jika ada 50 operasi concurrent, ada **50 polling loop berjalan sekaligus**, masing-masing membangunkan event loop 100× per detik.

```typescript
// VERSI LAMA — sangat buruk untuk CPU & memory
private waitForCompletion(operation: QueuedOperation): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const done = this.completedOps.find(o => o.id === operation.id);
      if (done) {
        clearInterval(poll);
        done.success ? resolve(done.result) : reject(new Error(done.error));
      }
    }, 10); // 10ms polling = 100× per detik per operasi!
  });
}
```

**Dampak:** CPU 100%, memory leak dari closure yang tidak terbebaskan selama operasi berlangsung.

**Perbaikan (sudah diterapkan):** Ganti dengan Promise callback resolution.

```typescript
// VERSI BARU — zero CPU saat menunggu
private readonly completionCallbacks = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}>();

private waitForCompletion(operation: QueuedOperation): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.completionCallbacks.delete(operation.id);
      reject(new Error(`Operation "${operation.id}" timed out`));
    }, this.config.maxExecutionTimeMs + this.config.maxWaitTimeMs);
    if (timeout.unref) timeout.unref();

    this.completionCallbacks.set(operation.id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
  });
}
```

---

### 2.3 Histogram Buffer 10.000 Sampel (HIGH)

**File:** `src/lib/performance-monitor.ts`

**Masalah:**  
`maxHistogramSamples` awalnya di-set ke `10_000`. Setiap metrik yang dipantau (ada puluhan) mengalokasikan array 10.000 float. Dengan 20 metrik aktif = **200.000 angka float** terus-menerus di heap.

```typescript
// SEBELUM
maxHistogramSamples: 10_000,  // 10K sampel × banyak metrik = OOM
leakDetectionIntervalMs: 60_000,  // cek tiap 1 menit
maxActiveTimers: 500,
```

**Perbaikan (sudah diterapkan):**

```typescript
// SESUDAH
maxHistogramSamples: 500,          // turun 20×
leakDetectionIntervalMs: 300_000,  // cek tiap 5 menit (bukan 1 menit)
maxActiveTimers: 200,              // turun dari 500
// alert history: 100 entri (bukan 1000)
```

---

### 2.4 Consistency Check Saat Startup (MEDIUM)

**File:** `src/lib/consistency-scheduler.ts`, `src/instrumentation.ts`

**Masalah:**  
Scheduler sebelumnya menjalankan query DB lengkap 1 menit setelah server start (sebelum pool siap), menyebabkan error dan spike memori di waktu yang paling kritis.

```typescript
// SEBELUM — query DB saat startup
startConsistencyScheduler(6 * 60 * 60 * 1000, true); // runOnStartup=true
```

**Perbaikan (sudah diterapkan):**

```typescript
// SESUDAH — hanya jadwal periodik, tidak saat startup
startConsistencyScheduler(6 * 60 * 60 * 1000, false); // runOnStartup=false
```

---

### 2.5 Health Endpoint Berat (MEDIUM)

**File:** `src/app/api/health/route.ts`

**Masalah:**  
Endpoint `/api/health` (dipanggil oleh uptime monitor setiap 30 detik) menjalankan 5 pemeriksaan berat secara paralel: connection pool test, performance metrics export, circuit breaker scan, push notification check, dll. Setiap pemeriksaan mengalokasikan memori sementara.

**Perbaikan (sudah diterapkan):**  
Pemeriksaan berat dipindahkan ke balik flag `?verbose=1`. Default hanya cek DB + memory.

```typescript
// Health endpoint default: hanya DB + memory
// Health endpoint verbose: semua cek (untuk debugging manual)
GET /api/health          → ringan, aman untuk uptime monitor
GET /api/health?verbose=1 → lengkap, untuk debugging
```

---

### 2.6 Memory Guard: Threshold Tidak Sensitif (LOW)

**File:** `src/lib/memory-guard.ts`

**Masalah (desain):**  
`underPressure` hanya aktif ketika **kedua kondisi** terpenuhi: heap ≥ 95% DAN pertumbuhan > 100 MB dari baseline. Ini benar secara konsep (V8 memang menjaga heap penuh ~85–95%), namun thresholdnya mungkin terlalu longgar untuk environment dengan RAM terbatas.

```typescript
// Kondisi "under pressure" saat ini
const underPressure = percent >= 95 && heapGrowthMB > 100;
```

**Rekomendasi:** Turunkan ambang pertumbuhan ke 50 MB untuk server dengan RAM < 1 GB.

```typescript
// Rekomendasi untuk low-memory server
const growthThreshold = process.env.LOW_MEMORY_MODE === '1' ? 50 : 100;
const underPressure = percent >= 90 && heapGrowthMB > growthThreshold;
```

---

## 3. Bug yang Ditemukan

### BUG-01: `tryProcessOperation` — Race Condition Double-Shift

**File:** `src/lib/concurrency-queue.ts` → `tryProcessOperation()` + `processQueue()`  
**Severity:** MEDIUM

**Masalah:**  
`tryProcessOperation()` memanggil `this.pendingQueue.shift()` di dalamnya (baris `this.pendingQueue.shift()`), tetapi `processQueue()` juga memanggil `this.pendingQueue.shift()` setelah `tryProcessOperation` return `true`. Ini menyebabkan operasi **yang berbeda** ikut ter-shift dari antrian.

```typescript
// processQueue() — LOOP UTAMA
while (this.pendingQueue.length > 0) {
  const operation = this.pendingQueue[0]; // peek operasi pertama
  // ...
  const canProceed = await this.tryProcessOperation(operation);
  if (!canProceed) break;
  this.pendingQueue.shift(); // ← BUG: tryProcessOperation sudah shift duluan!
}

// tryProcessOperation() — DI DALAMNYA JUGA SHIFT
private async tryProcessOperation(...): Promise<boolean> {
  // ...akuisisi kunci...
  this.pendingQueue.shift(); // ← sudah shift di sini
  // ...
  return true;
}
```

**Perbaikan:**

```typescript
// processQueue() — hapus shift setelah tryProcessOperation
while (this.pendingQueue.length > 0) {
  const operation = this.pendingQueue[0];
  // ...cek timeout & concurrency limit...
  const canProceed = await this.tryProcessOperation(operation);
  if (!canProceed) break;
  // TIDAK PERLU SHIFT LAGI — tryProcessOperation sudah melakukannya
}
```

---

### BUG-02: `BatchOptimizer.chunkedUpdate` — Counter Salah

**File:** `src/lib/batch-optimizer.ts` → `chunkedUpdate()`  
**Severity:** LOW

**Masalah:**  
`chunkedUpdate()` menginkremen `this.stats.chunkedInserts` (bukan counter update yang tepat). Ini membuat statistik menjadi tidak akurat (insert count menggelembung, padahal yang terjadi adalah update).

```typescript
async chunkedUpdate(...): Promise<void> {
  // ...
  this.stats.chunkedInserts++; // ← BUG: seharusnya chunkedUpdates
}
```

**Perbaikan:**

```typescript
// Tambahkan counter baru di stats
private stats = {
  deduplicationHits: 0,
  cacheHits: 0,
  dbFetches: 0,
  chunkedInserts: 0,
  chunkedUpdates: 0, // ← tambahkan ini
};

// Di chunkedUpdate():
this.stats.chunkedUpdates++;
```

---

### BUG-03: `MemoryGuard` — Baseline Tidak Diperbarui Saat Pool Tumbuh Normal

**File:** `src/lib/memory-guard.ts`  
**Severity:** LOW

**Masalah:**  
`baselineHeapMB` diambil satu kali saat `start()` dipanggil. Jika server berjalan lama dan heap tumbuh secara *sah* (karena lebih banyak data di-cache, lebih banyak koneksi), `underPressure` akan terus aktif padahal tidak ada kebocoran.

**Perbaikan:**

```typescript
// Perbarui baseline setelah periode stabil (misalnya setelah 1 jam uptime)
// sehingga pertumbuhan organik tidak salah dikira memory leak
private maybeRefreshBaseline(): void {
  const uptime = process.uptime();
  // Setelah 1 jam, anggap heap saat ini adalah "normal baru"
  if (uptime > 3600 && !this.baselineRefreshed) {
    const mem = process.memoryUsage();
    this.baselineHeapMB = mem.heapTotal / (1024 * 1024);
    this.baselineRefreshed = true;
    console.log(`[MemoryGuard] Baseline diperbarui: ${this.baselineHeapMB.toFixed(0)}MB`);
  }
}
```

---

### BUG-04: `ConnectionPool` — `maxLifetimeMs` Bukan Opsi Valid di `pg.PoolConfig`

**File:** `src/lib/connection-pool.ts`  
**Severity:** MEDIUM

**Masalah:**  
`maxLifetimeMs` bukan property yang valid di `node-postgres` `PoolConfig`. Property ini diam-diam diabaikan, sehingga koneksi tidak pernah di-recycle setelah 1 jam seperti yang dimaksudkan.

```typescript
const TRANSACTION_POOL_CONFIG: PoolConfig = {
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  maxLifetimeMs: 3_600_000, // ← TIDAK VALID, diabaikan oleh node-postgres
};
```

**Perbaikan:** Hapus `maxLifetimeMs` atau implementasikan manual via event `connect`.

```typescript
// Hapus maxLifetimeMs dari config
const TRANSACTION_POOL_CONFIG: PoolConfig = {
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: false,
};

// Jika recycle koneksi penting, tangani via event
pool.on('connect', (client: any) => {
  client._createdAt = Date.now();
});
```

---

### BUG-05: `next.config.ts` — Source Map Dev Dinonaktifkan Tanpa `NODE_ENV` Guard

**File:** `next.config.ts`  
**Severity:** LOW

**Masalah:**  
`config.devtool = false` selalu diterapkan di mode `dev`, membuat debugging sangat sulit karena semua stack trace merujuk ke kode yang sudah di-bundle.

```typescript
if (dev) {
  config.devtool = false; // ← tidak bisa debug sama sekali
  config.parallelism = 1;
}
```

**Perbaikan:** Buat conditional via environment variable.

```typescript
if (dev) {
  // Nonaktifkan source map hanya jika memori kritis
  config.devtool = process.env.DISABLE_SOURCEMAPS === '1' ? false : 'eval-cheap-source-map';
  config.parallelism = 1;
}
```

---

## 4. Perbaikan yang Sudah Diterapkan (Worklog)

Berdasarkan `worklog.md`, berikut perbaikan yang **sudah selesai** diterapkan:

| # | Komponen | Perubahan | Status |
|---|----------|-----------|--------|
| 1 | `performance-monitor.ts` | maxHistogramSamples: 10K → 500 | ✅ Done |
| 2 | `performance-monitor.ts` | leakDetectionInterval: 60s → 300s | ✅ Done |
| 3 | `performance-monitor.ts` | maxActiveTimers: 500 → 200 | ✅ Done |
| 4 | `performance-monitor.ts` | Singleton lazy via Proxy | ✅ Done |
| 5 | `concurrency-queue.ts` | Ganti polling 10ms → Promise callback | ✅ Done |
| 6 | `concurrency-queue.ts` | statsWindowSize: 1000 → 200 | ✅ Done |
| 7 | `concurrency-queue.ts` | Singleton lazy via Proxy | ✅ Done |
| 8 | `batch-optimizer.ts` | maxCacheSize: 500 → 100 | ✅ Done |
| 9 | `batch-optimizer.ts` | Singleton lazy via Proxy | ✅ Done |
| 10 | `consistency-scheduler.ts` | Nonaktifkan startup check | ✅ Done |
| 11 | `health/route.ts` | Pindah heavy check ke `?verbose=1` | ✅ Done |
| 12 | `instrumentation.ts` | Hapus eager PerformanceMonitor init | ✅ Done |
| 13 | `memory-init.ts` | Check interval: 2min → 5min | ✅ Done |

---

## 5. Langkah Penanganan Lanjutan

### Langkah 1 — Perbaiki BUG-01 (Race Condition Double-Shift)

Edit `src/lib/concurrency-queue.ts`:

```typescript
// Cari blok processQueue() dan hapus baris shift setelah tryProcessOperation
private async processQueue(): Promise<void> {
  while (this.pendingQueue.length > 0) {
    const operation = this.pendingQueue[0];

    // Timeout check
    if (operation.enqueuedAt && Date.now() - operation.enqueuedAt > this.config.maxWaitTimeMs) {
      this.pendingQueue.shift();
      this.recordCompletion(operation, false, undefined, 'Waktu tunggu antrian habis');
      continue;
    }

    // Concurrency limit check
    const limit = this.getConcurrencyLimit(operation.type);
    if (this.getProcessingCountByType(operation.type) >= limit) break;

    const canProceed = await this.tryProcessOperation(operation);
    if (!canProceed) break;
    // ← HAPUS: this.pendingQueue.shift() yang ada di sini
  }
}
```

### Langkah 2 — Perbaiki BUG-04 (maxLifetimeMs Invalid)

Edit `src/lib/connection-pool.ts`:

```typescript
// Hapus maxLifetimeMs dari kedua config object
const TRANSACTION_POOL_CONFIG: PoolConfig = {
  max: 20,
  min: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: false,
  // maxLifetimeMs: 3_600_000, ← HAPUS baris ini
};

const SESSION_POOL_CONFIG: PoolConfig = {
  max: 5,
  min: 1,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 30_000,
  allowExitOnIdle: false,
  // maxLifetimeMs: 3_600_000, ← HAPUS baris ini
};
```

### Langkah 3 — Tambahkan `--max-old-space-size` di Script Dev

Edit `package.json`:

```json
{
  "scripts": {
    "dev": "NODE_OPTIONS='--max-old-space-size=512' next dev",
    "start": "NODE_OPTIONS='--max-old-space-size=768' next start"
  }
}
```

> Ini mencegah Node.js meminta RAM ke OS tanpa batas. Jika heap mendekati 512 MB, GC akan lebih agresif bekerja daripada terus mengalokasikan.

### Langkah 4 — Tambahkan `gc-stats` ke MemoryGuard (Opsional)

Aktifkan GC hint dengan flag Node.js:

```bash
# Di .zscripts/dev.sh atau start.sh, tambahkan:
NODE_OPTIONS="--expose-gc --max-old-space-size=512" bun run dev
```

`memory-init.ts` sudah memanggil `globalThis.gc()` jika tersedia — ini hanya perlu diaktifkan via flag.

### Langkah 5 — Perbaiki BUG-02 (Counter Salah di chunkedUpdate)

Edit `src/lib/batch-optimizer.ts`:

```typescript
// 1. Tambahkan field baru di stats
private stats = {
  deduplicationHits: 0,
  cacheHits: 0,
  dbFetches: 0,
  chunkedInserts: 0,
  chunkedUpdates: 0, // ← TAMBAHKAN
};

// 2. Di method chunkedUpdate(), ganti:
this.stats.chunkedInserts++; // ← LAMA
// menjadi:
this.stats.chunkedUpdates++; // ← BARU

// 3. Di method getStats(), tambahkan field ke return:
return {
  // ...fields yang sudah ada...
  chunkedUpdates: this.stats.chunkedUpdates, // ← TAMBAHKAN
};
```

### Langkah 6 — Perbaiki BUG-03 (Baseline MemoryGuard)

Edit `src/lib/memory-guard.ts`:

```typescript
export class MemoryGuard {
  private baselineHeapMB: number = 0;
  private baselineRefreshed: boolean = false; // ← TAMBAHKAN

  private check(): void {
    this.maybeRefreshBaseline(); // ← PANGGIL DI SINI
    const stats = this.getStats();
    // ...sisa logika yang sudah ada...
  }

  private maybeRefreshBaseline(): void {
    if (this.baselineRefreshed) return;
    const uptimeSeconds = process.uptime();
    if (uptimeSeconds > 3600) { // setelah 1 jam
      const mem = process.memoryUsage();
      const newBaseline = mem.heapTotal / (1024 * 1024);
      console.log(
        `[MemoryGuard] Memperbarui baseline: ${this.baselineHeapMB.toFixed(0)}MB → ${newBaseline.toFixed(0)}MB`
      );
      this.baselineHeapMB = newBaseline;
      this.baselineRefreshed = true;
    }
  }
}
```

---

## 6. Konfigurasi Runtime yang Disarankan

### `.env` / Environment Variables

```bash
# Batas memori Node.js (sesuaikan dengan RAM server)
NODE_OPTIONS=--max-old-space-size=512

# Aktifkan GC manual (untuk memoryGuard.suggestCleanup())
# NODE_OPTIONS=--expose-gc --max-old-space-size=512

# Mode memori rendah (untuk VPS dengan RAM < 1 GB)
LOW_MEMORY_MODE=1

# Nonaktifkan source map dev jika butuh memori lebih
# DISABLE_SOURCEMAPS=1
```

### `next.config.ts` — Tambahan yang Disarankan

```typescript
const nextConfig: NextConfig = {
  // ...config yang sudah ada...

  // Batasi worker webpack untuk menghemat RAM saat build
  webpack: (config, { dev, isServer }) => {
    if (dev) {
      config.devtool = process.env.DISABLE_SOURCEMAPS === '1'
        ? false
        : 'eval-cheap-source-map'; // lebih hemat dari 'eval-source-map'
      config.parallelism = 1;

      // Batasi cache webpack dev
      config.cache = {
        type: 'memory',
        maxGenerations: 1, // hanya simpan 1 generasi cache
      };
    }
    return config;
  },
};
```

---

## 7. Monitoring & Deteksi Dini

### Endpoint Health

```bash
# Cek kesehatan dasar (ringan — cocok untuk uptime monitor)
curl http://localhost:3000/api/health

# Cek lengkap termasuk pool, circuit breaker, performance
curl http://localhost:3000/api/health?verbose=1

# Cek kesehatan antrian concurrency
curl http://localhost:3000/api/system/queue-health
```

### Indikator OOM Akan Datang

Pantau log server untuk tanda-tanda berikut:

```
# Peringatan memory leak dari PerformanceMonitor
[PerformanceMonitor] Terlalu banyak timer aktif: 180/200

# Pressure dari MemoryGuard
[MemoryGuard] CRITICAL: Heap at 96.2% (482.1MB / 501.2MB). RSS: 612.3MB.

# Antrian mulai menumpuk
[TransactionQueue] Antrian hampir penuh (>80%)

# Kunci stale mulai muncul
[ResourceLock] Kunci stale terdeteksi pada "product:abc123", dipegang 121000ms
```

### Script Monitoring Sederhana

Tambahkan ke `watchdog.sh` (sudah ada di repo):

```bash
#!/bin/bash
# Pantau RSS proses Next.js setiap 30 detik
while true; do
  PID=$(cat .zscripts/dev.pid 2>/dev/null)
  if [ -n "$PID" ]; then
    RSS=$(cat /proc/$PID/status 2>/dev/null | grep VmRSS | awk '{print $2}')
    RSS_MB=$((RSS / 1024))
    echo "[$(date '+%H:%M:%S')] PID=$PID RSS=${RSS_MB}MB"
    if [ "$RSS_MB" -gt 900 ]; then
      echo "⚠ PERINGATAN: RSS melebihi 900MB — kemungkinan OOM dalam waktu dekat"
    fi
  fi
  sleep 30
done
```

---

## 8. Checklist Deployment

Gunakan checklist ini sebelum deploy ke production:

### Pre-Deploy
- [ ] `NODE_OPTIONS=--max-old-space-size=512` sudah di-set di environment
- [ ] BUG-01 (double-shift) sudah diperbaiki di `concurrency-queue.ts`
- [ ] BUG-04 (`maxLifetimeMs`) sudah dihapus dari `connection-pool.ts`
- [ ] BUG-02 (counter update) sudah diperbaiki di `batch-optimizer.ts`
- [ ] Endpoint `/api/health` sudah diverifikasi ringan (tanpa `?verbose`)
- [ ] `runOnStartup=false` di `startConsistencyScheduler()`

### Post-Deploy (5 menit pertama)
- [ ] Pantau `GET /api/health` — harus return `200 OK` dalam 3 detik
- [ ] Pantau log untuk `[MemoryGuard] CRITICAL`
- [ ] Pantau RSS proses tidak melonjak > 600 MB dalam 5 menit pertama
- [ ] Verifikasi tidak ada `[ResourceLock] Kunci stale` dalam 10 menit pertama

### Ongoing
- [ ] Cek `/api/health?verbose=1` setiap jam selama 24 jam pertama
- [ ] Review log untuk `[TransactionQueue] GAGAL setelah` — tanda retry storm
- [ ] Pastikan `[ConsistencyScheduler]` hanya muncul setiap ~6 jam

---

*Dokumen ini dibuat berdasarkan analisis kode sumber `Arsip17April00_54.tar` tertanggal 17 April 2025. Semua perbaikan di Bagian 4 sudah diterapkan. Bagian 5 adalah tindak lanjut yang perlu dikerjakan.*
