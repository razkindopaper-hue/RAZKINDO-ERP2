/**
 * RAZKINDO-ERP2 Seed Data Script
 * 
 * Populates the local PostgreSQL database with realistic sample data for testing.
 * 
 * Usage: npx tsx scripts/seed-data.ts
 * 
 * This script is idempotent — it will skip records that already exist
 * (detected by unique constraints like email, SKU, invoice number, etc.).
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(section: string, message: string, status: 'ok' | 'skip' | 'err' = 'ok') {
  const icon = status === 'ok' ? '✅' : status === 'skip' ? '⏭️' : '❌';
  console.log(`  ${icon} ${section}: ${message}`);
}

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

function generateInvoiceNo(): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const seq = String(Math.floor(Math.random() * 9000) + 1000);
  return `INV-${y}${m}${d}-${seq}`;
}

async function main() {
  console.log('\n🌱 RAZKINDO-ERP2 Seed Data Script');
  console.log('═══════════════════════════════════════════\n');

  // ─── 1. Unit ────────────────────────────────────────────────────────────────
  console.log('📦 1. Creating Unit...');
  const unit = await prisma.unit.upsert({
    where: { id: 'unit-cabang-utama-seed' },
    update: {},
    create: {
      id: 'unit-cabang-utama-seed',
      name: 'Cabang Utama',
      address: 'Jl. Raya Industri No. 1, Surabaya',
      phone: '031-1234567',
      isActive: true,
    },
  });
  log('Unit', `"${unit.name}" (${unit.id})`);

  // ─── 2. Super Admin User ────────────────────────────────────────────────────
  console.log('\n👤 2. Creating Super Admin...');
  const adminPassword = hashPassword('admin123');
  const admin = await prisma.user.upsert({
    where: { email: 'admin@razkindo.com' },
    update: {},
    create: {
      id: 'user-admin-seed',
      email: 'admin@razkindo.com',
      password: adminPassword,
      name: 'Admin Utama',
      phone: '081200000001',
      role: 'super_admin',
      unitId: unit.id,
      status: 'approved',
      canLogin: true,
      isActive: true,
      nearCommission: 0,
      farCommission: 0,
    },
  });
  log('User', `"${admin.name}" (${admin.email})`);

  // UserUnit for admin
  try {
    await prisma.userUnit.create({
      data: {
        id: 'uu-admin-seed',
        userId: admin.id,
        unitId: unit.id,
      },
    });
    log('UserUnit', `Admin → ${unit.name}`);
  } catch {
    log('UserUnit', `Admin → ${unit.name} (already exists)`, 'skip');
  }

  // ─── 3. Regular Users ──────────────────────────────────────────────────────
  console.log('\n👥 3. Creating Regular Users...');

  const salesUser = await prisma.user.upsert({
    where: { email: 'budi@razkindo.com' },
    update: {},
    create: {
      id: 'user-budi-seed',
      email: 'budi@razkindo.com',
      password: hashPassword('budi123'),
      name: 'Budi Santoso',
      phone: '081200000002',
      role: 'sales',
      unitId: unit.id,
      status: 'approved',
      canLogin: true,
      isActive: true,
      nearCommission: 10000,
      farCommission: 20000,
    },
  });
  log('User', `"${salesUser.name}" (${salesUser.email}) — sales`);

  const kurirUser = await prisma.user.upsert({
    where: { email: 'agus@razkindo.com' },
    update: {},
    create: {
      id: 'user-agus-seed',
      email: 'agus@razkindo.com',
      password: hashPassword('agus123'),
      name: 'Agus Prasetyo',
      phone: '081200000003',
      role: 'kurir',
      unitId: unit.id,
      status: 'approved',
      canLogin: true,
      isActive: true,
      nearCommission: 10000,
      farCommission: 20000,
    },
  });
  log('User', `"${kurirUser.name}" (${kurirUser.email}) — kurir`);

  const keuanganUser = await prisma.user.upsert({
    where: { email: 'siti@razkindo.com' },
    update: {},
    create: {
      id: 'user-siti-seed',
      email: 'siti@razkindo.com',
      password: hashPassword('siti123'),
      name: 'Siti Rahayu',
      phone: '081200000004',
      role: 'keuangan',
      unitId: unit.id,
      status: 'approved',
      canLogin: true,
      isActive: true,
      nearCommission: 0,
      farCommission: 0,
    },
  });
  log('User', `"${keuanganUser.name}" (${keuanganUser.email}) — keuangan`);

  // UserUnit records for regular users
  const userUnits = [
    { id: 'uu-budi-seed', userId: salesUser.id, label: salesUser.name },
    { id: 'uu-agus-seed', userId: kurirUser.id, label: kurirUser.name },
    { id: 'uu-siti-seed', userId: keuanganUser.id, label: keuanganUser.name },
  ];
  for (const uu of userUnits) {
    try {
      await prisma.userUnit.create({
        data: { id: uu.id, userId: uu.userId, unitId: unit.id },
      });
      log('UserUnit', `${uu.label} → ${unit.name}`);
    } catch {
      log('UserUnit', `${uu.label} → ${unit.name} (already exists)`, 'skip');
    }
  }

  // ─── 4. Custom Role ────────────────────────────────────────────────────────
  console.log('\n🎭 4. Creating Custom Role...');
  const customRole = await prisma.customRole.upsert({
    where: { name: 'Sopir' },
    update: {},
    create: {
      id: 'role-sopir-seed',
      name: 'Sopir',
      description: 'Driver pengiriman',
      createdById: admin.id,
    },
  });
  log('CustomRole', `"${customRole.name}" — ${customRole.description}`);

  // ─── 5. Products ───────────────────────────────────────────────────────────
  console.log('\n📋 5. Creating Products...');

  const productsData = [
    {
      id: 'prod-khv-a4-70-seed',
      name: 'Kertas HVS A4 70gr',
      sku: 'KHV-A4-70',
      category: 'Kertas',
      unit: 'rim',
      subUnit: 'lembar',
      conversionRate: 500,
      globalStock: 150, // 150 rim in subUnits: 150 * 500 = 75000
      sellingPrice: 55000,
      avgHpp: 77, // approximate HPP per lembar
      purchasePrice: 38500,
    },
    {
      id: 'prod-khv-f4-70-seed',
      name: 'Kertas HVS F4 70gr',
      sku: 'KHV-F4-70',
      category: 'Kertas',
      unit: 'rim',
      subUnit: 'lembar',
      conversionRate: 500,
      globalStock: 80,
      sellingPrice: 52000,
      avgHpp: 72.8,
      purchasePrice: 36400,
    },
    {
      id: 'prod-kd-260-seed',
      name: 'Kertas Duplex 260gr',
      sku: 'KD-260',
      category: 'Kertas',
      unit: 'lembar',
      subUnit: 'lembar',
      conversionRate: 1,
      globalStock: 2000,
      sellingPrice: 3500,
      avgHpp: 2450,
      purchasePrice: 2450,
    },
    {
      id: 'prod-th-83a-seed',
      name: 'Toner HP 83A',
      sku: 'TH-83A',
      category: 'Toner',
      unit: 'pcs',
      subUnit: 'pcs',
      conversionRate: 1,
      globalStock: 25,
      sellingPrice: 450000,
      avgHpp: 315000,
      purchasePrice: 315000,
    },
    {
      id: 'prod-ap-c6-seed',
      name: 'Amplop Putih C6',
      sku: 'AP-C6',
      category: 'Amplop',
      unit: 'pack',
      subUnit: 'pcs',
      conversionRate: 50,
      globalStock: 60,
      sellingPrice: 35000,
      avgHpp: 25,
      purchasePrice: 1250,
    },
  ];

  const products: Record<string, typeof productsData[0]> = {};
  for (const pd of productsData) {
    const product = await prisma.product.upsert({
      where: { sku: pd.sku! },
      update: {},
      create: {
        id: pd.id,
        name: pd.name,
        sku: pd.sku,
        category: pd.category,
        unit: pd.unit,
        subUnit: pd.subUnit,
        conversionRate: pd.conversionRate,
        globalStock: pd.globalStock,
        sellingPrice: pd.sellingPrice,
        avgHpp: pd.avgHpp,
        purchasePrice: pd.purchasePrice,
        minStock: 10,
        stockType: 'centralized',
        trackStock: true,
        isActive: true,
      },
    });
    products[pd.id] = pd;
    log('Product', `${pd.name} (${pd.sku}) — Rp ${pd.sellingPrice.toLocaleString('id-ID')}/${pd.unit}`);
  }

  // ─── 6. Customers ──────────────────────────────────────────────────────────
  console.log('\n🏢 6. Creating Customers...');

  const customer1 = await prisma.customer.upsert({
    where: { code: 'CUST-MAJU' },
    update: {},
    create: {
      id: 'cust-maju-jaya-seed',
      name: 'CV Maju Jaya',
      code: 'CUST-MAJU',
      phone: '08123456789',
      email: 'info@majujaya.com',
      address: 'Jl. Pasar Besar No. 45, Surabaya',
      unitId: unit.id,
      distance: 'near',
      status: 'active',
      assignedToId: salesUser.id,
      totalOrders: 5,
      totalSpent: 2800000,
    },
  });
  log('Customer', `"${customer1.name}" (${customer1.distance}) → ${salesUser.name}`);

  const customer2 = await prisma.customer.upsert({
    where: { code: 'CUST-BERKAH' },
    update: {},
    create: {
      id: 'cust-berkah-sentosa-seed',
      name: 'PT Berkah Sentosa',
      code: 'CUST-BERKAH',
      phone: '08234567890',
      email: 'order@berkahsentosa.co.id',
      address: 'Jl. Rungkut Industri Raya No. 12, Surabaya',
      unitId: unit.id,
      distance: 'far',
      status: 'active',
      assignedToId: salesUser.id,
      totalOrders: 3,
      totalSpent: 1040000,
    },
  });
  log('Customer', `"${customer2.name}" (${customer2.distance}) → ${salesUser.name}`);

  const customer3 = await prisma.customer.upsert({
    where: { code: 'CUST-ABADI' },
    update: {},
    create: {
      id: 'cust-toko-abadi-seed',
      name: 'Toko Abadi',
      code: 'CUST-ABADI',
      phone: '08345678901',
      address: 'Jl. Basuki Rahmat No. 88, Surabaya',
      unitId: unit.id,
      distance: 'near',
      status: 'active',
      assignedToId: admin.id,
      totalOrders: 2,
      totalSpent: 500000,
    },
  });
  log('Customer', `"${customer3.name}" (${customer3.distance}) → ${admin.name}`);

  // ─── 7. Transactions ───────────────────────────────────────────────────────
  console.log('\n🧾 7. Creating Transactions...');

  // --- Transaction 1: CV Maju Jaya buys 10 rim HVS A4 + 5 pcs Toner HP 83A ---
  const invoiceNo1 = 'INV-250101-SEED-001';
  const now = new Date();

  // Calculate amounts for Transaction 1
  const t1_item1_qty = 10; // rim
  const t1_item1_qtySub = t1_item1_qty * 500; // lembar
  const t1_item1_price = 55000; // per rim
  const t1_item1_hpp = 77; // per lembar
  const t1_item1_subtotal = t1_item1_qty * t1_item1_price; // 550000
  const t1_item1_profit = t1_item1_subtotal - (t1_item1_qtySub * t1_item1_hpp); // 165000

  const t1_item2_qty = 5; // pcs
  const t1_item2_qtySub = 5; // pcs (same unit)
  const t1_item2_price = 450000; // per pcs
  const t1_item2_hpp = 315000; // per pcs
  const t1_item2_subtotal = t1_item2_qty * t1_item2_price; // 2250000
  const t1_item2_profit = t1_item2_subtotal - (t1_item2_qtySub * t1_item2_hpp); // 675000

  const t1_total = t1_item1_subtotal + t1_item2_subtotal; // 2800000
  const t1_totalHpp = (t1_item1_qtySub * t1_item1_hpp) + (t1_item2_qtySub * t1_item2_hpp); // 1960000
  const t1_totalProfit = t1_item1_profit + t1_item2_profit; // 840000

  let tx1Id = 'tx-seed-001';
  try {
    const tx1 = await prisma.transaction.create({
      data: {
        id: tx1Id,
        type: 'sale',
        invoiceNo: invoiceNo1,
        unitId: unit.id,
        createdById: salesUser.id,
        customerId: customer1.id,
        courierId: kurirUser.id,
        total: t1_total,
        paidAmount: t1_total,
        remainingAmount: 0,
        totalHpp: t1_totalHpp,
        totalProfit: t1_totalProfit,
        hppPaid: t1_totalHpp,
        profitPaid: t1_totalProfit,
        hppUnpaid: 0,
        profitUnpaid: 0,
        paymentMethod: 'cash',
        status: 'approved',
        paymentStatus: 'paid',
        deliveryDistance: customer1.distance,
        courierCommission: customer1.distance === 'near' ? 10000 : 20000,
        notes: 'Pesanan rutin kertas dan toner',
        transactionDate: now,
        items: {
          create: [
            {
              id: 'txi-seed-001-a',
              productId: productsData[0].id,
              productName: productsData[0].name,
              qty: t1_item1_qty,
              qtyInSubUnit: t1_item1_qtySub,
              qtyUnitType: 'main',
              price: t1_item1_price,
              hpp: t1_item1_hpp,
              subtotal: t1_item1_subtotal,
              profit: t1_item1_profit,
            },
            {
              id: 'txi-seed-001-b',
              productId: productsData[3].id,
              productName: productsData[3].name,
              qty: t1_item2_qty,
              qtyInSubUnit: t1_item2_qtySub,
              qtyUnitType: 'main',
              price: t1_item2_price,
              hpp: t1_item2_hpp,
              subtotal: t1_item2_subtotal,
              profit: t1_item2_profit,
            },
          ],
        },
      },
    });
    log('Transaction', `INV #${tx1.invoiceNo} — ${customer1.name} — Rp ${t1_total.toLocaleString('id-ID')}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Unique') || msg.includes('duplicate')) {
      log('Transaction', `INV #${invoiceNo1} (already exists)`, 'skip');
    } else {
      log('Transaction', `INV #${invoiceNo1} — ${msg}`, 'err');
    }
  }

  // --- Transaction 2: PT Berkah Sentosa buys 20 rim HVS F4 ---
  const invoiceNo2 = 'INV-250101-SEED-002';

  const t2_item1_qty = 20; // rim
  const t2_item1_qtySub = t2_item1_qty * 500; // lembar
  const t2_item1_price = 52000; // per rim
  const t2_item1_hpp = 72.8; // per lembar
  const t2_item1_subtotal = t2_item1_qty * t2_item1_price; // 1040000
  const t2_item1_profit = t2_item1_subtotal - (t2_item1_qtySub * t2_item1_hpp); // 312000

  const t2_total = t2_item1_subtotal; // 1040000
  const t2_totalHpp = t2_item1_qtySub * t2_item1_hpp; // 728000
  const t2_totalProfit = t2_item1_profit; // 312000

  try {
    const tx2 = await prisma.transaction.create({
      data: {
        id: 'tx-seed-002',
        type: 'sale',
        invoiceNo: invoiceNo2,
        unitId: unit.id,
        createdById: salesUser.id,
        customerId: customer2.id,
        courierId: kurirUser.id,
        total: t2_total,
        paidAmount: t2_total,
        remainingAmount: 0,
        totalHpp: t2_totalHpp,
        totalProfit: t2_totalProfit,
        hppPaid: t2_totalHpp,
        profitPaid: t2_totalProfit,
        hppUnpaid: 0,
        profitUnpaid: 0,
        paymentMethod: 'cash',
        status: 'approved',
        paymentStatus: 'paid',
        deliveryDistance: customer2.distance,
        courierCommission: customer2.distance === 'near' ? 10000 : 20000,
        notes: 'Pemesanan kertas F4 untuk kebutuhan kantor',
        transactionDate: now,
        items: {
          create: [
            {
              id: 'txi-seed-002-a',
              productId: productsData[1].id,
              productName: productsData[1].name,
              qty: t2_item1_qty,
              qtyInSubUnit: t2_item1_qtySub,
              qtyUnitType: 'main',
              price: t2_item1_price,
              hpp: t2_item1_hpp,
              subtotal: t2_item1_subtotal,
              profit: t2_item1_profit,
            },
          ],
        },
      },
    });
    log('Transaction', `INV #${tx2.invoiceNo} — ${customer2.name} — Rp ${t2_total.toLocaleString('id-ID')}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Unique') || msg.includes('duplicate')) {
      log('Transaction', `INV #${invoiceNo2} (already exists)`, 'skip');
    } else {
      log('Transaction', `INV #${invoiceNo2} — ${msg}`, 'err');
    }
  }

  // ─── 8. UnitProducts (Stock per Unit) ──────────────────────────────────────
  console.log('\n📦 8. Creating UnitProducts...');

  const unitProductsData = [
    {
      id: 'up-seed-hvs-a4',
      productId: productsData[0].id,
      stock: 150, // 150 rim available in this unit
      label: 'Kertas HVS A4 70gr',
    },
    {
      id: 'up-seed-hvs-f4',
      productId: productsData[1].id,
      stock: 80, // 80 rim
      label: 'Kertas HVS F4 70gr',
    },
  ];

  for (const up of unitProductsData) {
    try {
      await prisma.unitProduct.create({
        data: {
          id: up.id,
          unitId: unit.id,
          productId: up.productId,
          stock: up.stock,
        },
      });
      log('UnitProduct', `${up.label} — stock: ${up.stock}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Unique') || msg.includes('duplicate')) {
        log('UnitProduct', `${up.label} (already exists)`, 'skip');
      } else {
        log('UnitProduct', `${up.label} — ${msg}`, 'err');
      }
    }
  }

  // ─── 9. CashBox ────────────────────────────────────────────────────────────
  console.log('\n💰 9. Creating CashBox...');

  try {
    const cashBox = await prisma.cashBox.create({
      data: {
        id: 'cashbox-brankas-utama-seed',
        name: 'Brankas Utama',
        unitId: unit.id,
        balance: 5000000,
        isActive: true,
        notes: 'Brankas kas utama cabang Surabaya',
      },
    });
    log('CashBox', `"${cashBox.name}" — Rp ${cashBox.balance.toLocaleString('id-ID')}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Unique') || msg.includes('duplicate')) {
      log('CashBox', 'Brankas Utama (already exists)', 'skip');
    } else {
      log('CashBox', `Brankas Utama — ${msg}`, 'err');
    }
  }

  // ─── 10. Settings ──────────────────────────────────────────────────────────
  console.log('\n⚙️  10. Creating Settings...');

  const setting = await prisma.setting.upsert({
    where: { key: 'company_name' },
    update: {},
    create: {
      id: 'setting-company-name-seed',
      key: 'company_name',
      value: JSON.stringify('RAZKINDO PAPER'),
    },
  });
  log('Setting', `${setting.key} = ${setting.value}`);

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('🎉 Seed data completed successfully!\n');
  console.log('Login credentials:');
  console.log('  ┌─────────────────────────────────────────────────────┐');
  console.log('  │ Role       │ Email                  │ Password      │');
  console.log('  ├────────────┼────────────────────────┼───────────────┤');
  console.log('  │ Super Admin│ admin@razkindo.com     │ admin123      │');
  console.log('  │ Sales      │ budi@razkindo.com      │ budi123       │');
  console.log('  │ Kurir      │ agus@razkindo.com      │ agus123       │');
  console.log('  │ Keuangan   │ siti@razkindo.com      │ siti123       │');
  console.log('  └─────────────────────────────────────────────────────┘\n');
}

main()
  .catch((e) => {
    console.error('\n❌ Seed script failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
