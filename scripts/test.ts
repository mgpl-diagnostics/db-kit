// npm test — the same contract suite against real MongoDB (single-node replica set) and real
// PostgreSQL, both started in-process; then the Redis cache toolkit (ioredis-mock, or REDIS_URL),
// and the Fastify / Express adapters.
import { rmSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import Fastify from "fastify";
import RedisMock from "ioredis-mock";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import {
  balanceSheet, cancelInvoice, cancelVoucher, ConflictError, createBooking, createDb, dayBook, defaultPostingHook, gstSummary, invoiceBalance,
  issueInvoice, ledgerBalance, ledgerStatement, NotFoundError, outstandingReceivables, PeriodLockedError, postVoucher, profitAndLoss,
  recordPayment, registerPatient, seedChartOfAccounts, seedOrganization, transitionReport, trialBalance, UnbalancedVoucherError,
  type Branch, type Db, type Organization, type PostingHook, type Repositories,
} from "../src/index";
import { createCache, fixedWindowLimiter, slidingWindowLimiter, withCache, withLock } from "../src/cache/index";
import { createMongoRepositories, TransactionsUnsupportedError } from "../src/mongo/index";
import { createPgRepositories } from "../src/pg/index";
import { mgplDb } from "../src/adapters/fastify";
import { attachDb, dbErrorHandler } from "../src/adapters/express";

let failed = 0;
let passed = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) { passed++; console.log(`  ok    ${msg}`); }
  else { failed++; console.log(`  FAIL  ${msg}`); }
};
const rejects = async (p: Promise<unknown>, type: new (...a: any[]) => Error, msg: string) => {
  try { await p; ok(false, `${msg} (no error)`); } catch (e) { ok(e instanceof type, `${msg}${e instanceof type ? "" : ` (got ${(e as Error).name}: ${(e as Error).message})`}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ contract suite (both backends)

async function contract(db: Db) {
  const r = db.rawRepos;
  const tag = `[${db.backend}]`;
  console.log(`\n${tag} setup`);
  const { org, branch, owner } = await seedOrganization(r, {
    org: { name: "Maa Gayatri Path Lab", code: "MGPL", gstin: "22AAAAA0000A1Z5" },
    branch: { code: "RPR01", name: "Raipur" },
    owner: { name: "Owner", email: "Owner@Example.com", passwordHash: "scrypt$test" },
  });
  ok(org.id && branch.orgId === org.id && owner.email === "owner@example.com", `${tag} seed: org, branch, owner (email lower-cased)`);
  await rejects(seedOrganization(r, { org: { name: "Dup", code: "MGPL" }, branch: { code: "X", name: "X" }, owner: { name: "x", email: "x@x.in", passwordHash: "h" } }), Error, `${tag} duplicate org code rejected (unique index)`);
  const coa = await seedChartOfAccounts(r, org.id);
  ok(coa.groups.length === 28, `${tag} chart of accounts: ${coa.groups.length} Tally groups`);
  ok(coa.ledgers.some((l) => l.systemKey === "receivables") && coa.ledgers.length >= 19, `${tag} default ledgers: ${coa.ledgers.length}`);
  ok((await seedChartOfAccounts(r, org.id)).ledgers.length === coa.ledgers.length, `${tag} seeding the chart again is idempotent`);

  console.log(`${tag} patients, bookings, reports`);
  const p1 = await registerPatient(r, { orgId: org.id, branchId: branch.id, name: "Kavita Sharma", sex: "female", ageYears: 32, phone: "9000000001" });
  const p2 = await registerPatient(r, { orgId: org.id, branchId: branch.id, name: "Ravi Verma", sex: "male", ageYears: 45, phone: "9000000002" });
  ok(p1.uhid === "MGPL-000001" && p2.uhid === "MGPL-000002", `${tag} UHIDs ${p1.uhid}, ${p2.uhid}`);
  ok((await r.patients.search(org.id, "kav"))[0]?.id === p1.id && (await r.patients.search(org.id, "000002"))[0]?.id === p2.id, `${tag} patient search by name and UHID`);
  ok(p1.createdAt instanceof Date && !("_id" in p1), `${tag} entities have id + Date timestamps`);

  const { booking, samples } = await createBooking(r, {
    orgId: org.id, branchId: branch.id, patientId: p1.id,
    tests: [
      { testCode: "CBC", name: "Complete Blood Count", pricePaise: 39900, sampleType: "EDTA" },
      { testCode: "LIFT", name: "Liver Function Tests", pricePaise: 64900, sampleType: "SERUM" },
      { testCode: "KIPR", name: "Kidney Profile", pricePaise: 59900, sampleType: "SERUM" },
    ],
  }, owner.id);
  ok(/^RPR01-\d{6}-0001$/.test(booking.bookingNo), `${tag} booking number ${booking.bookingNo}`);
  ok(samples.length === 2 && new Set(samples.map((s) => s.barcode)).size === 2, `${tag} one sample per sample type (${samples.map((s) => s.barcode).join(", ")})`);

  const report = await r.reports.create({ orgId: org.id, branchId: branch.id, bookingId: booking.id, patientId: p1.id, testCode: "CBC", testName: "CBC", results: [], status: "draft", version: 1 });
  await transitionReport(r, report.id, "entered", owner.id, { results: [{ parameter: "Hemoglobin", value: "10.8", unit: "g/dL", flag: "L" }] });
  const verified = await transitionReport(r, report.id, "verified", owner.id);
  ok(verified.status === "verified" && verified.verifiedBy === owner.id && verified.results[0]?.value === "10.8", `${tag} report draft → entered → verified`);
  await rejects(transitionReport(r, report.id, "draft", owner.id), ConflictError, `${tag} illegal report transition rejected`);

  console.log(`${tag} invoices, payments, ACID`);
  const { invoice, payments } = await issueInvoice(r, {
    orgId: org.id, branchId: branch.id, patientId: p1.id, bookingId: booking.id,
    items: [
      { code: "CBC", name: "Complete Blood Count", ratePaise: 39900 },
      { code: "LIFT", name: "Liver Function Tests", ratePaise: 64900, discountPaise: 4900 },
      { code: "SYR5", name: "Syringe 5 ml", category: "consumable", qty: 2, ratePaise: 1000, taxPercent: 12 },
    ],
    billDiscountPaise: 5000,
    payments: [{ amountPaise: 50000, mode: "cash" }],
  }, owner.id);
  ok(/^MGPL\/RPR01\/\d{4}-\d{2}\/000001$/.test(invoice.invoiceNo), `${tag} invoice number ${invoice.invoiceNo}`);
  ok(invoice.totalPaise % 100 === 0 && invoice.paidPaise === 50000 && invoice.duePaise === invoice.totalPaise - 50000, `${tag} totals: Rs ${invoice.totalPaise / 100}, paid 500, due ${invoice.duePaise / 100}`);
  ok(invoice.status === "partially_paid" && payments.length === 1, `${tag} status partially_paid`);
  ok((await r.bookings.get(booking.id))?.invoiceId === invoice.id, `${tag} booking linked to invoice`);

  await rejects(recordPayment(r, { invoiceId: invoice.id, amountPaise: invoice.duePaise + 100, mode: "upi" }), ConflictError, `${tag} overpayment rejected`);
  // two concurrent payments that together exceed the due amount: the lock lets exactly one through
  const half = Math.ceil(invoice.duePaise / 2) + 100;
  const race = await Promise.allSettled([
    recordPayment(r, { invoiceId: invoice.id, amountPaise: half, mode: "upi" }),
    recordPayment(r, { invoiceId: invoice.id, amountPaise: half, mode: "card" }),
  ]);
  const after = (await r.invoices.get(invoice.id))!;
  ok(race.filter((x) => x.status === "fulfilled").length === 1 && after.paidPaise === 50000 + half, `${tag} concurrent payments: one accepted, one rejected (no lost update)`);
  // deterministic lock check: while T1 holds the invoice, T2's getForUpdate must wait for T1's commit
  let held!: () => void;
  const holding = new Promise<void>((res) => (held = res));
  const t1 = r.transaction(async (tx) => { await tx.invoices.getForUpdate(invoice.id); held(); await sleep(300); });
  await holding;
  const waitStart = Date.now();
  await r.transaction(async (tx) => tx.invoices.getForUpdate(invoice.id));
  const waited = Date.now() - waitStart;
  await t1;
  ok(waited >= 200, `${tag} invoice lock: a second transaction waited ${waited} ms for the first to commit`);

  const paid = await recordPayment(r, { invoiceId: invoice.id, amountPaise: after.duePaise, mode: "upi", reference: "UPI123" });
  ok(paid.invoice.status === "paid" && paid.invoice.duePaise === 0, `${tag} paid in full`);
  const refund = await recordPayment(r, { invoiceId: invoice.id, amountPaise: 10000, mode: "cash", kind: "refund" });
  ok(refund.invoice.status === "partially_paid" && refund.invoice.duePaise === 10000, `${tag} refund re-opens Rs 100 due`);

  // atomicity: a failing transaction leaves nothing behind (not even a consumed counter)
  const doctorsBefore = await r.doctors.count({ orgId: org.id });
  const seqBefore = await r.counters.peek("test:atomic");
  await rejects(r.transaction(async (tx) => {
    await tx.doctors.create({ orgId: org.id, name: "Dr Rollback", active: true });
    await tx.counters.next("test:atomic");
    throw new ConflictError("boom");
  }), ConflictError, `${tag} transaction error propagates`);
  ok((await r.doctors.count({ orgId: org.id })) === doctorsBefore && (await r.counters.peek("test:atomic")) === seqBefore, `${tag} rollback: no doctor, no counter increment`);

  const unpaid = (await issueInvoice(r, { orgId: org.id, branchId: branch.id, patientId: p2.id, items: [{ name: "Blood Group", ratePaise: 11900 }] })).invoice;
  ok(unpaid.invoiceNo.endsWith("000002") && unpaid.status === "issued", `${tag} second invoice ${unpaid.invoiceNo} (gap-free series)`);
  await rejects(cancelInvoice(r, invoice.id, "test"), ConflictError, `${tag} cannot cancel an invoice with payments`);

  console.log(`${tag} accounting`);
  const tb = await trialBalance(r, { orgId: org.id });
  ok(tb.totalDebitPaise === tb.totalCreditPaise && tb.totalDebitPaise > 0, `${tag} trial balance balances: Dr ${tb.totalDebitPaise} = Cr ${tb.totalCreditPaise}`);
  const recv = (await r.ledgers.findBySystemKey(org.id, "receivables"))!;
  const dues = (await r.invoices.find({ orgId: org.id })).reduce((s, i) => s + i.duePaise, 0);
  ok((await ledgerBalance(r, { orgId: org.id, ledgerId: recv.id })) === dues, `${tag} Patient Receivables = sum of invoice dues (${dues})`);
  const cash = (await r.ledgers.findBySystemKey(org.id, "cash"))!;
  ok((await ledgerBalance(r, { orgId: org.id, ledgerId: cash.id })) === 50000 - 10000, `${tag} cash ledger = 500 received − 100 refunded`);
  const from = new Date(Date.now() - 86400000), to = new Date(Date.now() + 86400000);
  const st = await ledgerStatement(r, { orgId: org.id, ledgerId: recv.id, from, to });
  ok(st.closingPaise === dues && st.rows.at(-1)?.balancePaise === dues, `${tag} ledger statement running balance closes at ${st.closingPaise}`);
  const pl = await profitAndLoss(r, { orgId: org.id, from, to });
  const bs = await balanceSheet(r, { orgId: org.id, asOf: to });
  ok(bs.differencePaise === 0 && bs.profitPaise === pl.netProfitPaise, `${tag} balance sheet balances; profit ${pl.netProfitPaise} matches P&L`);
  const gst = await gstSummary(r, { orgId: org.id, from, to });
  ok(gst.totalTaxPaise === invoice.taxPaise && gst.cgstPaise + gst.sgstPaise === invoice.taxPaise, `${tag} GST summary: CGST ${gst.cgstPaise} + SGST ${gst.sgstPaise}`);
  const out = await outstandingReceivables(r, { orgId: org.id });
  ok(out.totalDuePaise === dues && out.buckets["0-30"] === dues, `${tag} outstanding receivables with ageing`);
  const book = await dayBook(r, { orgId: org.id, from, to });
  ok(book.filter((v) => v.type === "sales").length === 2 && book.filter((v) => v.type === "receipt").length === 3 && book.some((v) => v.type === "payment"), `${tag} day book: ${book.length} vouchers (2 sales, 3 receipts, 1 refund)`);

  await rejects(postVoucher(r, { orgId: org.id, branchId: branch.id, type: "journal", entries: [{ ledgerId: cash.id, debitPaise: 100, creditPaise: 0 }, { ledgerId: recv.id, debitPaise: 0, creditPaise: 90 }] }), UnbalancedVoucherError, `${tag} unbalanced voucher rejected`);
  const capital = (await r.ledgers.findBySystemKey(org.id, "capital"))!;
  const jv = await postVoucher(r, { orgId: org.id, branchId: branch.id, type: "receipt", narration: "Capital introduced", entries: [{ ledgerId: cash.id, debitPaise: 1000000, creditPaise: 0 }, { ledgerId: capital.id, debitPaise: 0, creditPaise: 1000000 }] });
  ok(jv.voucherNo.startsWith("RCT/") && (await trialBalance(r, { orgId: org.id })).differencePaise === 0, `${tag} manual voucher ${jv.voucherNo}; books still balance`);

  const cancelled = await cancelInvoice(r, unpaid.id, "duplicate", owner.id);
  const salesVouchers = await r.vouchers.find({ invoiceId: unpaid.id } as any);
  ok(cancelled.status === "cancelled" && salesVouchers.every((v) => v.status === "cancelled"), `${tag} cancelling an invoice cancels its sales voucher`);
  ok((await r.ledgerEntries.list({ orgId: org.id, invoiceId: unpaid.id })).length === 0 && (await trialBalance(r, { orgId: org.id })).differencePaise === 0, `${tag} its postings are removed; books balance`);
  ok((await r.audit.find({ orgId: org.id })).length > 10, `${tag} audit log written`);
  await rejects(recordPayment(r, { invoiceId: "00000000-0000-4000-8000-000000000000", amountPaise: 100, mode: "cash" }), NotFoundError, `${tag} unknown invoice → NotFoundError`);
  return { org, branch };
}

// ------------------------------------------------------------------ finance storage (both backends)

/** Storage used by finance-kit: B2B customers, partners, settlements, cash, bank, lock dates, tax rules, credit notes. */
async function financeStorage(db: Db, org: Organization, branch: Branch, withPosting: (hook: PostingHook) => Promise<Repositories>) {
  const r = db.rawRepos;
  const tag = `[${db.backend}]`;
  const orgId = org.id;
  console.log(`\n${tag} finance storage`);
  const ledgerIn = async (group: string, name: string) => {
    const g = (await r.accountGroups.findOne({ orgId, name: group }))!;
    return r.ledgers.create({ orgId, name, groupId: g.id, openingPaise: 0, systemKey: null, active: true });
  };

  const b2 = await r.branches.create({ orgId, code: "BLS01", name: "Bilaspur CC", kind: "collection_center", stateCode: "22", active: true });
  ok((await r.branches.get(b2.id))?.stateCode === "22", `${tag} branch stateCode`);

  // customers: unique code, own ledger, row lock
  const custLedger = await ledgerIn("Sundry Debtors", "City Hospital");
  const cust = await r.customers.create({ orgId, code: "CITYHOSP", name: "City Hospital", kind: "hospital", gstin: "22AABCC1234D1Z5", stateCode: "22", creditLimitPaise: 5000000, creditDays: 30, ledgerId: custLedger.id, active: true });
  ok(cust.code === "CITYHOSP" && cust.creditLimitPaise === 5000000 && cust.ledgerId === custLedger.id, `${tag} customer stored with its own ledger`);
  await rejects(r.customers.create({ orgId, code: "CITYHOSP", name: "Dup", kind: "other", creditLimitPaise: null, creditDays: 0, ledgerId: custLedger.id, active: true }), Error, `${tag} duplicate customer code rejected`);
  const open = await r.customers.create({ orgId, code: "WALKCORP", name: "Walk Corp", kind: "corporate", creditLimitPaise: null, creditDays: 15, ledgerId: (await ledgerIn("Sundry Debtors", "Walk Corp")).id, active: true });
  ok(open.creditLimitPaise === null, `${tag} customer without a credit limit keeps null`);
  let held!: () => void;
  const holding = new Promise<void>((res) => (held = res));
  const t1 = r.transaction(async (tx) => { await tx.customers.getForUpdate(cust.id); held(); await sleep(300); });
  await holding;
  const waitStart = Date.now();
  await r.transaction(async (tx) => tx.customers.getForUpdate(cust.id));
  const waited = Date.now() - waitStart;
  await t1;
  ok(waited >= 200, `${tag} customer lock: a second transaction waited ${waited} ms`);

  // B2B invoice fields, GST line fields, listByDate
  const patient = (await r.patients.find({ orgId }))[0]!;
  const { invoice: b2b } = await issueInvoice(r, {
    orgId, branchId: branch.id, patientId: patient.id, customerId: cust.id, placeOfSupply: "22", buyerGstin: cust.gstin,
    items: [{ code: "CBC", name: "CBC", ratePaise: 39900, hsnSac: "999316", taxability: "exempt" }, { code: "SYR", name: "Syringe", category: "consumable", ratePaise: 1000, taxPercent: 12, hsnSac: "9018", taxability: "taxable" }],
  });
  const got = (await r.invoices.get(b2b.id))!;
  ok(got.customerId === cust.id && got.placeOfSupply === "22" && got.buyerGstin === "22AABCC1234D1Z5" && got.creditedPaise === 0, `${tag} invoice: customer, place of supply, buyer GSTIN, creditedPaise 0`);
  ok(got.items[0]?.hsnSac === "999316" && got.items[0]?.taxability === "exempt" && got.items[1]?.taxability === "taxable", `${tag} invoice lines keep SAC/HSN and taxability`);
  const day = 86400000;
  const listed = await r.invoices.listByDate({ orgId, from: new Date(Date.now() - day), to: new Date(Date.now() + day) });
  const byCust = await r.invoices.listByDate({ orgId, customerId: cust.id });
  ok(listed.length >= 2 && listed.every((i) => i.status !== "cancelled") && byCust.length === 1 && byCust[0]!.id === b2b.id, `${tag} invoices.listByDate (by date and customer; cancelled left out)`);
  ok((await r.invoices.listByDate({ orgId, includeCancelled: true })).some((i) => i.status === "cancelled"), `${tag} invoices.listByDate includeCancelled`);
  const { duePaise, status } = invoiceBalance({ totalPaise: 10000, creditedPaise: 10000 }, 0);
  const part = invoiceBalance({ totalPaise: 10000, creditedPaise: 4000 }, 6000);
  ok(duePaise === 0 && status === "credited" && part.duePaise === 0 && part.status === "paid", `${tag} invoiceBalance: credit notes reduce what is due`);

  // tax rules
  const rule = await r.taxRules.create({ orgId, code: null, category: "medicine", hsnSac: "3004", taxability: "taxable", ratePercent: 0.25, effectiveFrom: new Date("2026-04-01T00:00:00+05:30"), effectiveTo: null });
  const ruleBack = (await r.taxRules.find({ orgId, category: "medicine" }))[0]!;
  ok(ruleBack.id === rule.id && ruleBack.ratePercent === 0.25 && typeof ruleBack.ratePercent === "number" && ruleBack.code === null && ruleBack.effectiveFrom instanceof Date, `${tag} tax rule (fractional rate stays a number)`);

  // partners, agreements, settlements
  const payable = await ledgerIn("Sundry Creditors", "Bilaspur CC Partner");
  const partner = await r.partners.create({ orgId, code: "BLS", name: "Bilaspur CC", kind: "collection_centre", branchId: b2.id, pan: "ABCDE1234F", ledgerId: payable.id, tds: { section: "194H", rateBp: 200 }, active: true });
  ok(partner.tds?.rateBp === 200 && (await r.partners.get(partner.id))?.tds?.section === "194H", `${tag} partner with a TDS override`);
  const ag = await r.partnerAgreements.create({ orgId, partnerId: partner.id, kind: "fixed_rate", rates: [{ code: "CBC", sharePaise: 8000 }], defaultSharePaise: 5000, effectiveFrom: new Date("2026-04-01T00:00:00+05:30"), effectiveTo: null });
  const agBack = (await r.partnerAgreements.find({ partnerId: partner.id }))[0]!;
  ok(agBack.id === ag.id && agBack.rates?.[0]?.sharePaise === 8000 && agBack.categories === undefined && agBack.shareBp === null, `${tag} agreement: rates round-trip`);
  const sBase = {
    orgId, branchId: branch.id, partnerId: partner.id, period: "2026-10", from: new Date("2026-10-01T00:00:00+05:30"), to: new Date("2026-10-31T23:59:59.999+05:30"),
    lines: [{ invoiceId: b2b.id, invoiceNo: b2b.invoiceNo, day: "2026-10-03", code: "CBC", name: "CBC", netPaise: 39900, sharePaise: 8000, agreementId: ag.id }],
    grossPaise: 39900, sharePaise: 8000, deductions: [{ label: "Tubes", amountPaise: 500 }], deductionsPaise: 500, tdsSection: "194H", tdsRateBp: 200, tdsBasePaise: 8000, tdsPaise: 200, netPaise: 7300, status: "draft" as const,
  };
  const s1 = await r.settlements.create({ ...sBase, periodKey: `${partner.id}:2026-10` });
  ok(s1.lines[0]?.day === "2026-10-03" && s1.deductions[0]?.label === "Tubes" && (await r.settlements.get(s1.id))?.lines[0]?.sharePaise === 8000, `${tag} settlement lines and deductions round-trip`);
  await rejects(r.settlements.create({ ...sBase, periodKey: `${partner.id}:2026-10` }), Error, `${tag} one live settlement per partner per month (unique periodKey)`);
  await r.settlements.update(s1.id, { status: "cancelled", periodKey: null });
  const s2 = await r.settlements.create({ ...sBase, periodKey: `${partner.id}:2026-10` });
  await r.settlements.update(s2.id, { status: "cancelled", periodKey: null });
  ok((await r.settlements.count({ partnerId: partner.id, status: "cancelled" })) === 2, `${tag} cancelled settlements free the month (several null periodKeys)`);

  // cash closings
  const cc = await r.cashClosings.create({ orgId, branchId: b2.id, day: "2026-10-14", bookPaise: 100000, countedPaise: 99500, differencePaise: -500, denominations: [{ valuePaise: 50000, count: 1 }, { valuePaise: 100, count: 495 }], closedBy: null });
  ok(cc.denominations?.length === 2 && cc.differencePaise === -500, `${tag} cash closing with denominations`);
  await rejects(r.cashClosings.create({ orgId, branchId: b2.id, day: "2026-10-14", bookPaise: 0, countedPaise: 0, differencePaise: 0 }), Error, `${tag} one cash closing per branch per day`);

  // bank statements and lines
  const bank = (await r.ledgers.findBySystemKey(orgId, "bank"))!;
  const stmt = await r.bankStatements.create({ orgId, branchId: branch.id, ledgerId: bank.id, fileName: "oct.csv", from: null, to: null, lineCount: 1 });
  const line = await r.bankLines.create({ orgId, statementId: stmt.id, ledgerId: bank.id, date: new Date("2026-10-05T00:00:00+05:30"), description: "UPI SETTLEMENT", debitPaise: 0, creditPaise: 98000, dedupKey: "k1", status: "unmatched", voucherIds: [] });
  ok(Array.isArray(line.voucherIds) && line.voucherIds.length === 0 && line.status === "unmatched", `${tag} bank line stored`);
  await r.bankLines.update(line.id, { status: "matched", matchKind: "settlement", voucherIds: [b2b.id], settlement: { ledgerId: bank.id, day: "2026-10-04", grossPaise: 100000, feePaise: 2000 } });
  const lineBack = (await r.bankLines.get(line.id))!;
  ok(lineBack.voucherIds[0] === b2b.id && lineBack.settlement?.feePaise === 2000 && (await r.bankLines.count({ ledgerId: bank.id, status: "matched" })) === 1, `${tag} bank line match fields round-trip`);
  await rejects(r.bankLines.create({ orgId, statementId: stmt.id, ledgerId: bank.id, date: new Date(), description: "dup", debitPaise: 0, creditPaise: 1, dedupKey: "k1", status: "unmatched", voucherIds: [] }), Error, `${tag} bank line dedupKey is unique (re-import adds nothing)`);

  // credit notes
  const cn = await r.creditNotes.create({
    orgId, branchId: branch.id, invoiceId: b2b.id, customerId: cust.id, noteNo: "MGPL/RPR01/CN/2026-27/000001", date: new Date(), reason: "price correction",
    lines: [{ itemIndex: 1, name: "Syringe", hsnSac: "9018", taxability: "taxable", taxPercent: 12, taxablePaise: 1000, taxPaise: 120, cgstPaise: 60, sgstPaise: 60, igstPaise: 0 }],
    taxablePaise: 1000, taxPaise: 120, cgstPaise: 60, sgstPaise: 60, igstPaise: 0, roundOffPaise: 0, totalPaise: 1120, status: "issued",
  });
  ok((await r.creditNotes.listByDate({ orgId, from: new Date(Date.now() - day), to: new Date(Date.now() + day) }))[0]?.id === cn.id && (await r.creditNotes.find({ invoiceId: b2b.id }))[0]?.lines[0]?.cgstPaise === 60, `${tag} credit note stored and listed by date`);

  // lock dates: postings and cancellations on or before the lock fail, inside the transaction
  const cash = (await r.ledgers.findBySystemKey(orgId, "cash"))!;
  const capital = (await r.ledgers.findBySystemKey(orgId, "capital"))!;
  const jv = (date: Date, b = b2.id) => postVoucher(r, { orgId, branchId: b, type: "journal", date, entries: [{ ledgerId: cash.id, debitPaise: 100, creditPaise: 0 }, { ledgerId: capital.id, debitPaise: 0, creditPaise: 100 }] });
  const sept = await jv(new Date("2026-09-15T10:00:00+05:30"));
  const locks = await r.transaction((tx) => tx.periodLocks.hold(orgId, [b2.id, "org"], "update"));
  ok(locks.length === 2 && locks.every((l) => l.lockedUpTo === null) && locks.some((l) => l.scope === "org" && l.branchId === null), `${tag} periodLocks.hold creates empty org and branch rows`);
  const lockedUpTo = new Date("2026-09-30T23:59:59.999+05:30");
  await r.transaction(async (tx) => {
    const [l] = await tx.periodLocks.hold(orgId, [b2.id], "update");
    await tx.periodLocks.update(l!.id, { lockedUpTo });
  });
  await rejects(jv(new Date("2026-09-30T18:00:00+05:30")), PeriodLockedError, `${tag} posting on the lock date fails`);
  await rejects(cancelVoucher(r, sept.id), ConflictError, `${tag} cancelling a voucher in a locked period fails (ConflictError)`);
  ok((await jv(new Date("2026-09-30T18:00:00+05:30"), branch.id)).status === "posted" && (await jv(new Date("2026-10-01T00:00:00+05:30"))).status === "posted", `${tag} other branches and later dates still post`);
  // concurrency: a lock moved forward while a posting is in flight still stops it
  let lockHeld!: () => void;
  const lockHolding = new Promise<void>((res) => (lockHeld = res));
  const mover = r.transaction(async (tx) => {
    const [l] = await tx.periodLocks.hold(orgId, ["org"], "update");
    lockHeld();
    await sleep(300);
    await tx.periodLocks.update(l!.id, { lockedUpTo: new Date("2026-10-10T23:59:59.999+05:30") });
  });
  await lockHolding;
  await rejects(jv(new Date("2026-10-05T12:00:00+05:30"), branch.id), PeriodLockedError, `${tag} concurrent lock change: the in-flight posting waits, then fails`);
  await mover;
  await r.transaction(async (tx) => {
    for (const l of await tx.periodLocks.hold(orgId, ["org", b2.id], "update")) await tx.periodLocks.update(l.id, { lockedUpTo: null });
  });

  // closing vouchers stay out of the P&L
  const sales = (await r.ledgers.findBySystemKey(orgId, "sales"))!;
  const from = new Date(Date.now() - day), to = new Date(Date.now() + day);
  const before = await profitAndLoss(r, { orgId, from, to });
  const closing = await postVoucher(r, { orgId, branchId: branch.id, type: "closing", entries: [{ ledgerId: sales.id, debitPaise: 1000, creditPaise: 0 }, { ledgerId: capital.id, debitPaise: 0, creditPaise: 1000 }] });
  const after = await profitAndLoss(r, { orgId, from, to });
  const tot = await r.ledgerEntries.totals({ orgId, ledgerId: sales.id, excludeVoucherTypes: ["closing"] });
  const all = await r.ledgerEntries.totals({ orgId, ledgerId: sales.id });
  ok(closing.voucherNo.startsWith("CLS/") && after.netProfitPaise === before.netProfitPaise && all[0]!.debitPaise - tot[0]!.debitPaise === 1000, `${tag} closing voucher ${closing.voucherNo}: left out of the P&L and of excludeVoucherTypes totals`);
  await cancelVoucher(r, closing.id);

  // posting hook: billing calls the configured hook inside its transaction
  const calls: string[] = [];
  const spy: PostingHook = {
    async invoiceIssued(tx, inv, a) { calls.push(`issued:${tx.posting === spy}`); await defaultPostingHook.invoiceIssued(tx, inv, a); },
    async paymentRecorded(tx, p, no, a) { calls.push(`paid:${p.mode}`); await defaultPostingHook.paymentRecorded(tx, p, no, a); },
    async invoiceCancelled(tx, id, a) { calls.push("cancelled"); await defaultPostingHook.invoiceCancelled(tx, id, a); },
  };
  const hooked = await withPosting(spy);
  const hi = await issueInvoice(hooked, { orgId, branchId: branch.id, patientId: patient.id, items: [{ name: "ESR", ratePaise: 9900 }], payments: [{ amountPaise: 5000, mode: "upi" }] });
  await recordPayment(hooked, { invoiceId: hi.invoice.id, amountPaise: 4900, mode: "cash" });
  const hc = await issueInvoice(hooked, { orgId, branchId: branch.id, patientId: patient.id, items: [{ name: "ESR", ratePaise: 9900 }] });
  await cancelInvoice(hooked, hc.invoice.id, "test");
  ok(calls.join(",") === "issued:true,paid:upi,paid:cash,issued:true,cancelled", `${tag} posting hook called by issueInvoice / recordPayment / cancelInvoice (${calls.join(",")})`);
  ok((await trialBalance(r, { orgId })).differencePaise === 0, `${tag} books still balance`);
  await hooked.close();
}

// ------------------------------------------------------------------ cache toolkit

async function cacheSuite() {
  console.log("\n[cache]");
  const real = process.env.REDIS_URL;
  const make = async () => (real ? new (await import("ioredis")).default(real) : (new RedisMock() as any));
  const redis = await make();
  if (!real) await redis.flushall();
  const prefix = `t${Date.now()}:`;
  const cache = createCache(redis, { prefix, ttl: 60 });

  let loads = 0;
  const loader = async () => { loads++; await sleep(30); return { name: "CBC", at: new Date("2026-01-01T00:00:00Z") }; };
  const a = await cache.getOrSet("x", loader);
  const b = await cache.getOrSet("x", loader);
  ok(loads === 1 && b.at instanceof Date && b.at.toISOString() === a.at.toISOString(), "cache-aside: second read is a hit; Dates survive");

  loads = 0;
  await Promise.all(Array.from({ length: 20 }, () => cache.getOrSet("sf", loader)));
  ok(loads === 1, "single-flight: 20 concurrent misses → 1 load");

  loads = 0;
  const other = createCache(redis, { prefix, ttl: 60 }); // a second server sharing Redis
  await Promise.all([cache.getOrSet("lock", loader), other.getOrSet("lock", loader)]);
  ok(loads === 1 && other.stats().lockWaits + cache.stats().lockWaits >= 1, "stampede lock: two servers, one load, the other waits for the value");

  let version = 1;
  const v = async () => ({ v: version });
  await cache.getOrSet("swr", v, { ttl: 1, staleTtl: 30 });
  version = 2;
  await sleep(1300);
  const stale = await cache.getOrSet("swr", v, { ttl: 1, staleTtl: 30 });
  await sleep(100);
  const fresh = await cache.getOrSet("swr", v, { ttl: 1, staleTtl: 30 });
  ok(stale.v === 1 && fresh.v === 2, "stale-while-revalidate: stale value served instantly, refreshed in background");

  loads = 0;
  const missing = async () => { loads++; return null; };
  await cache.getOrSet("nf", missing, { negativeTtl: 30 });
  await cache.getOrSet("nf", missing, { negativeTtl: 30 });
  ok(loads === 1, "negative caching: a miss is remembered");

  await cache.getOrSet("p:1:profile", async () => 1, { tags: ["patient:1"] });
  await cache.getOrSet("p:1:reports", async () => 2, { tags: ["patient:1"] });
  ok((await cache.invalidateTags("patient:1")) === 2 && (await cache.get("p:1:profile")) === undefined, "tags: invalidate every key of patient 1");

  const ns = cache.namespace("catalog");
  await ns.getOrSet("cbc", async () => "old");
  await ns.bump();
  ok((await ns.getOrSet("cbc", async () => "new")) === "new", "versioned namespace: bump drops it in O(1)");

  const l1a = createCache(redis, { prefix: `${prefix}l1:`, l1: { ttlMs: 60_000 }, subscriber: await (real ? make() : redis.duplicate()) });
  const l1b = createCache(redis, { prefix: `${prefix}l1:`, l1: { ttlMs: 60_000 }, subscriber: await (real ? make() : redis.duplicate()) });
  await sleep(50);
  await l1a.getOrSet("k", async () => "A");
  await l1b.getOrSet("k", async () => "A");
  await l1b.getOrSet("k", async () => "A");
  ok(l1b.stats().l1Hits >= 1, "two-tier: repeat reads served from in-process L1");
  await l1a.set("k", "B");
  await sleep(100);
  ok((await l1b.getOrSet("k", async () => "A")) === "B", "two-tier: a write on server A clears L1 on server B (pub/sub)");

  const sliding = slidingWindowLimiter(redis, { limit: 3, windowMs: 1000, prefix: `${prefix}rl:` });
  const s = [await sliding("ip"), await sliding("ip"), await sliding("ip"), await sliding("ip")];
  ok(s.slice(0, 3).every((x) => x.allowed) && !s[3]!.allowed && s[3]!.retryAfterMs > 0, "sliding-window limiter: 3 allowed, 4th blocked with retry-after");
  const fixed = fixedWindowLimiter(redis, { limit: 2, windowMs: 60_000, prefix: `${prefix}rf:` });
  ok((await fixed("k")).allowed && (await fixed("k")).allowed && !(await fixed("k")).allowed, "fixed-window limiter");

  let inside = 0, maxInside = 0;
  await Promise.all(Array.from({ length: 5 }, () => withLock(redis, `${prefix}job`, async () => { inside++; maxInside = Math.max(maxInside, inside); await sleep(20); inside--; }, { waitMs: 5000 })));
  ok(maxInside === 1, "distributed lock: mutual exclusion");
  return { redis, cache };
}

// ------------------------------------------------------------------ main

async function main() {
  const t0 = Date.now();
  // MongoDB: a one-node replica set, so transactions are real
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const mongo = await createDb({ backend: "mongo", mongo: { uri: rs.getUri("mgpl_test") } });
  const m = await contract(mongo);
  await financeStorage(mongo, m.org, m.branch, (posting) => createMongoRepositories({ uri: rs.getUri("mgpl_test"), posting }));

  // a standalone server refuses multi-document work instead of silently losing atomicity
  const standalone = await MongoMemoryServer.create();
  const sa = await createMongoRepositories({ uri: standalone.getUri("sa") });
  await rejects(sa.transaction(async () => 1), TransactionsUnsupportedError, "[mongo] standalone server: transaction() refuses (ACID)");
  ok((await (await createMongoRepositories({ uri: standalone.getUri("sa2"), allowNoTransactions: true })).transaction(async () => 7)) === 7, "[mongo] allowNoTransactions opt-in for dev");
  await sa.close();
  await standalone.stop();

  // PostgreSQL: a real server in a temp folder
  rmSync(".pg-test", { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: ".pg-test", user: "postgres", password: "postgres", port: 54329, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("mgpl_test");
  const pgUrl = "postgres://postgres:postgres@localhost:54329/mgpl_test";
  const pgdb = await createDb({ backend: "pg", pg: { url: pgUrl } });
  const p = await contract(pgdb);
  await financeStorage(pgdb, p.org, p.branch, (posting) => createPgRepositories({ url: pgUrl, posting }));

  const { redis, cache } = await cacheSuite();

  console.log("\n[adapters]");
  const cached = withCache(mongo.rawRepos, cache, 60);
  const anyOrg = (await mongo.rawRepos.orgs.find())[0]!;
  await cached.orgs.get(anyOrg.id);
  await cached.orgs.update(anyOrg.id, { name: "Renamed Lab" });
  ok((await cached.orgs.get(anyOrg.id))?.name === "Renamed Lab", "cached repositories: update invalidates the cached read");

  const app = Fastify();
  await app.register(mgplDb, { db: { ...pgdb, repos: pgdb.rawRepos } });
  app.get("/orgs", async () => app.db.repos.orgs.find());
  app.get("/invoice/:id", async (req: any) => {
    const inv = await app.db.repos.invoices.get(req.params.id);
    if (!inv) throw new NotFoundError("Invoice", req.params.id);
    return inv;
  });
  const res = await app.inject({ url: "/orgs" });
  ok(res.statusCode === 200 && res.json()[0].code === "MGPL", "fastify: plugin decorates app.db, routes use repositories");
  const nf = await app.inject({ url: "/invoice/00000000-0000-4000-8000-000000000000" });
  ok(nf.statusCode === 404, "fastify: NotFoundError → 404");
  await app.close();

  let seen: any;
  attachDb(pgdb)({}, {}, () => {});
  const req: any = {};
  attachDb(pgdb)(req, {}, () => { seen = req.db; });
  const sent: any = {};
  dbErrorHandler()(new ConflictError("x"), {}, { status: (s: number) => ({ json: (b: unknown) => Object.assign(sent, { s, b }) }) }, () => {});
  ok(seen === pgdb && sent.s === 409, "express: attachDb + dbErrorHandler (409)");

  await mongo.close();
  await rs.stop();
  await pgdb.close();
  await pg.stop();
  rmSync(".pg-test", { recursive: true, force: true });
  redis.disconnect();

  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
