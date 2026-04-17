---
Task ID: 1
Agent: Main Agent
Task: Fix pool dana komposisi dana - sync menghasilkan 0, selisih -290.000, reset 0, dan sales target bug

Work Log:
- Investigated pool dana sync logic: found RPC `get_payment_pool_sums` via Prisma + Supabase REST fallback
- Discovered root cause of sync→0: `db.rpc('get_payment_pool_sums')` was failing in the Next.js runtime, falling back to Supabase REST which only counted payments with cashBoxId/bankAccountId (ignoring handovers), so when all payments go via courier → fallback returns 0
- Replaced `fetchRpcPoolSums()` (used `db.rpc()`) with `fetchPoolSumsFromPrisma()` (uses `prisma` directly) — bypasses unreliable RPC layer
- Fixed `computeSyncPreview()` to include `courierSums.hppPending + courierSums.profitPending` in suggested values → totalPool = totalPhysical → selisih = 0
- Fixed manual update dialog to include courier cash in totalPhysical (brankas + bank + kurir)
- Removed `reset_to_zero` action from backend POST handler
- Removed Reset 0 button and AlertDialog from frontend FinanceModule
- Removed `RotateCcw` import and `resetPoolsMutation` / `showResetConfirm` state
- Fixed pool settings directly in DB (HPP=175000, Profit=115000) to restore correct values after Reset 0 damage
- Discovered sales target API bug: PostgREST converts `SalesTarget` table name to `sales_targets` (snake_case) which doesn't exist
- Fixed by replacing all `db.from('SalesTarget')` calls with Prisma queries in: sales/targets/route.ts, sales/targets/[id]/route.ts, dashboard/route.ts, sales/dashboard/route.ts

Stage Summary:
- Pool dana: HPP=175000, Profit=115000, selisih=0 ✓
- Sync now correctly calculates from Prisma (direct payments + handovers - deductions + courier pending) ✓
- Manual update includes courier cash in totalPhysical ✓
- Reset 0 completely removed ✓
- Sales target API fully functional (GET/POST/PATCH/DELETE all work via Prisma) ✓
- All changes compile without TypeScript errors ✓
