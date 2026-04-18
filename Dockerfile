# =====================================================================
# Razkindo2 ERP - Docker Image for CasaOS / Docker Deployment
# =====================================================================
# Multi-stage build:
#   1. deps     — install all dependencies
#   2. builder  — build Next.js + compile event-queue TS→JS
#   3. runner   — minimal production image
# =====================================================================

# ---- Stage 1: Dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN npm install 2>/dev/null || true

# Install event-queue deps
COPY mini-services/event-queue/package.json mini-services/event-queue/bun.lock* ./mini-services/event-queue/
RUN cd mini-services/event-queue && npm install 2>/dev/null || true

# ---- Stage 2: Builder ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/mini-services/event-queue/node_modules ./mini-services/event-queue/node_modules
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build Next.js (standalone output)
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Compile event-queue TypeScript → JavaScript (using esbuild, fast & reliable)
RUN npm install -g esbuild && \
    cd /app/mini-services/event-queue && \
    esbuild index.ts --bundle --platform=node --outfile=index.js --format=cjs --packages=external

# ---- Stage 3: Runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone Next.js build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schema + generated client (needed at runtime for DB queries)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy event-queue mini-service (compiled JS + production deps)
COPY --from=builder /app/mini-services/event-queue/index.js ./mini-services/event-queue/index.js
COPY --from=builder /app/mini-services/event-queue/node_modules ./mini-services/event-queue/node_modules

# Copy entrypoint script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Create data directory
RUN mkdir -p /app/db && chown nextjs:nodejs /app/db

USER nextjs

EXPOSE 3000 3004

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
