# Worklog

---
Task ID: 1
Agent: Main Agent
Task: Explore codebase structure for Razkindo2 ERP fixes

Work Log:
- Read Prisma schema (35+ models)
- Read FinanceModule.tsx (1900+ lines)
- Read SettingsModule.tsx
- Read PoolAdjustForm.tsx
- Read API routes: pools, settings/[key], payments, finance/requests/[id]
- Read supabase.ts (RPC handlers)
- Read atomic-ops.ts
- Identified 4 key issues to fix

Stage Summary:
- Found that get_payment_pool_sums RPC was reading from settings (self-referencing!) instead of payments table
- Found settings PATCH route missing generateId() and updated_at for new inserts
- Found ExpensesTab exists but lacks 2-step workflow (pool source selection)
- Pool dana auto-initialize logic prevents starting from 0

---
Task ID: 2
Agent: Main Agent
Task: Fix Pool Dana - remove auto-initialize, fix RPC, add reset-to-0

Work Log:
- Fixed get_payment_pool_sums RPC in supabase.ts to query actual payments table via Prisma aggregate
- Removed auto-initialize logic from GET /api/finance/pools (pool can now truly start at 0)
- Added reset_to_zero action to POST /api/finance/pools
- Added updated_at to all settings upsert operations in pools route
- FinanceModule already has Reset 0 button with resetPoolsMutation

Stage Summary:
- Pool dana can now start at 0 and be reset to 0
- actualHppSum/actualProfitSum now correctly shows ground truth from payments table
- Reset to 0 action available via POST { action: "reset_to_zero" }

---
Task ID: 3
Agent: Main Agent
Task: Fix Settings Update - add generateId() and updated_at

Work Log:
- Rewrote PATCH /api/settings/[key] route
- Split upsert into check-then-insert/update pattern
- INSERT: includes id: generateId(), created_at, updated_at
- UPDATE: includes updated_at
- This fixes Supabase REST not auto-generating cuid() for id field

Stage Summary:
- Settings (company_name, company_logo, login_warning) should now save correctly
- Root cause: Supabase REST doesn't auto-generate id like Prisma does

---
Task ID: 4
Agent: Main Agent
Task: Add Pengeluaran (Expense) feature with 2-step workflow

Work Log:
- Created /api/finance/expenses route (GET for listing, POST for creating)
- POST creates direct expense with 2-step workflow (pool deduction + physical account deduction)
- Uses atomicUpdatePoolBalance and atomicUpdateBalance for atomic operations
- Uses runInTransaction with compensating rollback for safety
- Updated ExpensesTab.tsx with 2-step workflow UI (fund source + physical account selection)
- Added category selection, unit selection, and proper form validation
- Expense list shows with category badges and pagination

Stage Summary:
- Direct expense creation bypasses finance request approval workflow
- 2-step workflow: Step 1 (HPP/Profit pool), Step 2 (Bank/Brankas physical)
- Expenses are tracked as Transaction type='expense' with EXP- invoice prefix

---
Task ID: 5
Agent: Main Agent
Task: Fix employee unit assignment not saving + pool reset not working

Work Log:
- Investigated DB schema: user_units table has id (NOT NULL, no default) + created_at columns
- Found root cause: API insert only sent user_id + unit_id, missing required id column
- Error was caught silently by try/catch with only console.warn
- Fixed: Added id: generateId() to each user_units insert row
- Fixed: Changed silent catch to return 500 error to user
- Investigated DB schema: settings table has id (NOT NULL, no default), created_at (default CURRENT_TIMESTAMP), updated_at (NOT NULL, no default)
- Found pool settings still had non-zero values (HPP=80135, Profit=34864) despite reset attempt
- Root cause: pools route still used Supabase REST upsert without id — same bug as settings fix
- Verified via direct Supabase REST API test: upsert without id fails with NOT NULL constraint error
- Rewrote pools route: created upsertSetting() helper using check-existing → update/insert pattern
- Also fixed same bug in ai/discrepancy/route.ts (2 more upsert calls)
- Verified: no more settings upsert calls remain in codebase
- Pool values confirmed at 0 in DB after fix

Stage Summary:
- Employee unit assignment now works: generates id for user_units rows
- Pool reset to 0 now works: all settings operations use safe upsert pattern
- Discrepancy fix route also fixed to prevent future regression
- TypeScript compiles with 0 errors
