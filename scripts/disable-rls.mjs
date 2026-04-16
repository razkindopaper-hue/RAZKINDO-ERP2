import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://postgres.eglmvtleuonoeomovnwa:Arthanto01091987@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres',
});

await client.connect();

const tables = [
  'custom_roles', 'units', 'users', 'user_units', 'password_resets',
  'products', 'unit_products', 'customers', 'customer_follow_ups',
  'suppliers', 'transactions', 'transaction_items', 'payments',
  'payment_proofs', 'salary_payments', 'bank_accounts', 'cash_boxes',
  'finance_requests', 'fund_transfers', 'company_debts', 'company_debt_payments',
  'receivables', 'receivable_follow_ups', 'logs', 'events',
  'sales_targets', 'sales_tasks', 'sales_task_reports',
  'courier_cash', 'courier_handovers', 'push_subscriptions',
  'settings', 'cashback_config', 'cashback_log', 'cashback_withdrawal',
  'customer_referral'
];

console.log('🔓 Disabling RLS on all tables...');

for (const table of tables) {
  try {
    await client.query(`ALTER TABLE public."${table}" DISABLE ROW LEVEL SECURITY;`);
    console.log(`  ✅ ${table}`);
  } catch (e) {
    console.log(`  ⚠️ ${table}: ${e.message}`);
  }
}

await client.end();
console.log('✅ RLS disabled on all tables');
