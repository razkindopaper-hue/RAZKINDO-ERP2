// =====================================================================
// POST /api/setup/seed — Seed sample data (Docker-compatible)
//
// Populates the database with sample data for testing.
// Safe to call multiple times (idempotent — skips existing records).
// Only works if no users exist yet (prevents accidental overwrite).
// =====================================================================

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/supabase';
import bcrypt from 'bcryptjs';

function log(msg: string) {
  console.log(`[Seed] ${msg}`);
}

async function hashPwd(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function POST() {
  try {
    // Safety check: only seed if database is empty
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return NextResponse.json({
        success: false,
        message: `Database sudah memiliki ${userCount} user. Seed data hanya bisa dijalankan pada database kosong.`,
      }, { status: 400 });
    }

    log('Starting seed...');
    const results: string[] = [];

    // ── 1. Unit ──
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
    results.push(`Unit: ${unit.name}`);

    // ── 2. Super Admin ──
    const admin = await prisma.user.upsert({
      where: { email: 'admin@razkindo.com' },
      update: {},
      create: {
        id: 'user-admin-seed',
        email: 'admin@razkindo.com',
        password: await hashPwd('admin123'),
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
    results.push(`Admin: ${admin.email}`);

    // Admin UserUnit
    try {
      await prisma.userUnit.create({ data: { id: 'uu-admin-seed', userId: admin.id, unitId: unit.id } });
    } catch { /* exists */ }

    // ── 3. Regular Users ──
    const usersData = [
      { id: 'user-budi-seed', email: 'budi@razkindo.com', password: 'budi123', name: 'Budi Santoso', phone: '081200000002', role: 'sales', nearCommission: 10000, farCommission: 20000 },
      { id: 'user-agus-seed', email: 'agus@razkindo.com', password: 'agus123', name: 'Agus Prasetyo', phone: '081200000003', role: 'kurir', nearCommission: 10000, farCommission: 20000 },
      { id: 'user-siti-seed', email: 'siti@razkindo.com', password: 'siti123', name: 'Siti Rahayu', phone: '081200000004', role: 'keuangan', nearCommission: 0, farCommission: 0 },
    ];

    const salesUser = await prisma.user.upsert({
      where: { email: usersData[0].email },
      update: {},
      create: { ...usersData[0], password: await hashPwd(usersData[0].password), unitId: unit.id, status: 'approved', canLogin: true, isActive: true },
    });
    results.push(`Sales: ${salesUser.email}`);

    const kurirUser = await prisma.user.upsert({
      where: { email: usersData[1].email },
      update: {},
      create: { ...usersData[1], password: await hashPwd(usersData[1].password), unitId: unit.id, status: 'approved', canLogin: true, isActive: true },
    });
    results.push(`Kurir: ${kurirUser.email}`);

    const keuanganUser = await prisma.user.upsert({
      where: { email: usersData[2].email },
      update: {},
      create: { ...usersData[2], password: await hashPwd(usersData[2].password), unitId: unit.id, status: 'approved', canLogin: true, isActive: true },
    });
    results.push(`Keuangan: ${keuanganUser.email}`);

    // UserUnits
    for (const uu of [
      { id: 'uu-budi-seed', userId: salesUser.id },
      { id: 'uu-agus-seed', userId: kurirUser.id },
      { id: 'uu-siti-seed', userId: keuanganUser.id },
    ]) {
      try {
        await prisma.userUnit.create({ data: { ...uu, unitId: unit.id } });
      } catch { /* exists */ }
    }

    // ── 4. Custom Role ──
    const customRole = await prisma.customRole.upsert({
      where: { name: 'Sopir' },
      update: {},
      create: { id: 'role-sopir-seed', name: 'Sopir', description: 'Driver pengiriman', createdById: admin.id },
    });
    results.push(`Role: ${customRole.name}`);

    // ── 5. Products ──
    const prods = [
      { id: 'prod-khv-a4-70-seed', name: 'Kertas HVS A4 70gr', sku: 'KHV-A4-70', category: 'Kertas', unit: 'rim', subUnit: 'lembar', conversionRate: 500, globalStock: 150, sellingPrice: 55000, avgHpp: 77, purchasePrice: 38500 },
      { id: 'prod-khv-f4-70-seed', name: 'Kertas HVS F4 70gr', sku: 'KHV-F4-70', category: 'Kertas', unit: 'rim', subUnit: 'lembar', conversionRate: 500, globalStock: 80, sellingPrice: 52000, avgHpp: 72.8, purchasePrice: 36400 },
      { id: 'prod-kd-260-seed', name: 'Kertas Duplex 260gr', sku: 'KD-260', category: 'Kertas', unit: 'lembar', subUnit: 'lembar', conversionRate: 1, globalStock: 2000, sellingPrice: 3500, avgHpp: 2450, purchasePrice: 2450 },
      { id: 'prod-th-83a-seed', name: 'Toner HP 83A', sku: 'TH-83A', category: 'Toner', unit: 'pcs', subUnit: 'pcs', conversionRate: 1, globalStock: 25, sellingPrice: 450000, avgHpp: 315000, purchasePrice: 315000 },
      { id: 'prod-ap-c6-seed', name: 'Amplop Putih C6', sku: 'AP-C6', category: 'Amplop', unit: 'pack', subUnit: 'pcs', conversionRate: 50, globalStock: 60, sellingPrice: 35000, avgHpp: 25, purchasePrice: 1250 },
    ];

    for (const p of prods) {
      await prisma.product.upsert({
        where: { sku: p.sku },
        update: {},
        create: { ...p, minStock: 10, stockType: 'centralized', trackStock: true, isActive: true },
      });
      results.push(`Produk: ${p.name}`);
    }

    // ── 6. Customers ──
    const cust1 = await prisma.customer.upsert({
      where: { code: 'CUST-MAJU' },
      update: {},
      create: { id: 'cust-maju-jaya-seed', name: 'CV Maju Jaya', code: 'CUST-MAJU', phone: '08123456789', email: 'info@majujaya.com', address: 'Jl. Pasar Besar No. 45, Surabaya', unitId: unit.id, distance: 'near', status: 'active', assignedToId: salesUser.id },
    });
    results.push(`Pelanggan: ${cust1.name}`);

    const cust2 = await prisma.customer.upsert({
      where: { code: 'CUST-BERKAH' },
      update: {},
      create: { id: 'cust-berkah-sentosa-seed', name: 'PT Berkah Sentosa', code: 'CUST-BERKAH', phone: '08234567890', email: 'order@berkahsentosa.co.id', address: 'Jl. Rungkut Industri Raya No. 12, Surabaya', unitId: unit.id, distance: 'far', status: 'active', assignedToId: salesUser.id },
    });
    results.push(`Pelanggan: ${cust2.name}`);

    const cust3 = await prisma.customer.upsert({
      where: { code: 'CUST-ABADI' },
      update: {},
      create: { id: 'cust-toko-abadi-seed', name: 'Toko Abadi', code: 'CUST-ABADI', phone: '08345678901', address: 'Jl. Basuki Rahmat No. 88, Surabaya', unitId: unit.id, distance: 'near', status: 'active', assignedToId: admin.id },
    });
    results.push(`Pelanggan: ${cust3.name}`);

    // ── 7. Transactions ──
    const now = new Date();

    // TX1: CV Maju Jaya — 10 rim HVS A4 + 5 pcs Toner HP 83A = Rp 2,800,000
    try {
      const t1Total = 550000 + 2250000;
      await prisma.transaction.create({
        data: {
          id: 'tx-seed-001', type: 'sale', invoiceNo: 'INV-250101-SEED-001',
          unitId: unit.id, createdById: salesUser.id, customerId: cust1.id, courierId: kurirUser.id,
          total: t1Total, paidAmount: t1Total, remainingAmount: 0,
          totalHpp: 1960000, totalProfit: 840000,
          hppPaid: 1960000, profitPaid: 840000, hppUnpaid: 0, profitUnpaid: 0,
          paymentMethod: 'cash', status: 'approved', paymentStatus: 'paid',
          deliveryDistance: 'near', courierCommission: 10000,
          notes: 'Pesanan rutin kertas dan toner', transactionDate: now,
          items: {
            create: [
              { id: 'txi-seed-001-a', productId: prods[0].id, productName: prods[0].name, qty: 10, qtyInSubUnit: 5000, qtyUnitType: 'main', price: 55000, hpp: 77, subtotal: 550000, profit: 165000 },
              { id: 'txi-seed-001-b', productId: prods[3].id, productName: prods[3].name, qty: 5, qtyInSubUnit: 5, qtyUnitType: 'main', price: 450000, hpp: 315000, subtotal: 2250000, profit: 675000 },
            ],
          },
        },
      });
      results.push('Transaksi: INV-250101-SEED-001 (Rp 2.800.000)');
    } catch { results.push('Transaksi: INV-250101-SEED-001 (skip)'); }

    // TX2: PT Berkah Sentosa — 20 rim HVS F4 = Rp 1,040,000
    try {
      const t2Total = 1040000;
      await prisma.transaction.create({
        data: {
          id: 'tx-seed-002', type: 'sale', invoiceNo: 'INV-250101-SEED-002',
          unitId: unit.id, createdById: salesUser.id, customerId: cust2.id, courierId: kurirUser.id,
          total: t2Total, paidAmount: t2Total, remainingAmount: 0,
          totalHpp: 728000, totalProfit: 312000,
          hppPaid: 728000, profitPaid: 312000, hppUnpaid: 0, profitUnpaid: 0,
          paymentMethod: 'cash', status: 'approved', paymentStatus: 'paid',
          deliveryDistance: 'far', courierCommission: 20000,
          notes: 'Pemesanan kertas F4', transactionDate: now,
          items: {
            create: [
              { id: 'txi-seed-002-a', productId: prods[1].id, productName: prods[1].name, qty: 20, qtyInSubUnit: 10000, qtyUnitType: 'main', price: 52000, hpp: 72.8, subtotal: 1040000, profit: 312000 },
            ],
          },
        },
      });
      results.push('Transaksi: INV-250101-SEED-002 (Rp 1.040.000)');
    } catch { results.push('Transaksi: INV-250101-SEED-002 (skip)'); }

    // ── 8. CashBox ──
    try {
      await prisma.cashBox.create({
        data: { id: 'cashbox-brankas-utama-seed', name: 'Brankas Utama', unitId: unit.id, balance: 5000000, isActive: true },
      });
      results.push('Brankas: Rp 5.000.000');
    } catch { results.push('Brankas: (skip)'); }

    // ── 9. Setting ──
    await prisma.setting.upsert({
      where: { key: 'company_name' },
      update: {},
      create: { id: 'setting-company-name-seed', key: 'company_name', value: JSON.stringify('RAZKINDO PAPER') },
    });
    results.push('Setting: company_name');

    log(`Seed completed! ${results.length} items created.`);

    return NextResponse.json({
      success: true,
      message: 'Seed data berhasil dimuat!',
      results,
      credentials: {
        superAdmin: { email: 'admin@razkindo.com', password: 'admin123' },
        sales: { email: 'budi@razkindo.com', password: 'budi123' },
        kurir: { email: 'agus@razkindo.com', password: 'agus123' },
        keuangan: { email: 'siti@razkindo.com', password: 'siti123' },
      },
    });
  } catch (error) {
    console.error('[Seed] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Seed gagal' },
      { status: 500 }
    );
  }
}

export async function GET() {
  // Check if database has been seeded
  try {
    const userCount = await prisma.user.count();
    return NextResponse.json({
      seeded: userCount > 0,
      userCount,
      message: userCount > 0
        ? `Database sudah terisi (${userCount} user). Tidak perlu seed lagi.`
        : 'Database kosong. Jalankan POST /api/setup/seed untuk mengisi data contoh.',
    });
  } catch {
    return NextResponse.json({ seeded: false, error: 'Database belum terkoneksi' }, { status: 500 });
  }
}
