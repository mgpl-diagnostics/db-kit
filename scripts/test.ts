// npm test — the same contract suite against real MongoDB (single-node replica set) and real
// PostgreSQL, both started in-process; then the Redis cache toolkit (ioredis-mock, or REDIS_URL),
// and the Fastify / Express adapters.
import { rmSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import Fastify from "fastify";
import RedisMock from "ioredis-mock";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import {
  balanceSheet, cancelInvoice, ConflictError, createBooking, createDb, dayBook, gstSummary, issueInvoice, ledgerBalance,
  ledgerStatement, NotFoundError, outstandingReceivables, postVoucher, profitAndLoss, recordPayment, registerPatient,
  seedChartOfAccounts, seedOrganization, transitionReport, trialBalance, UnbalancedVoucherError, type Db,
} from "../src/index";
import { createCache, fixedWindowLimiter, slidingWindowLimiter, withCache, withLock } from "../src/cache/index";
import { createMongoRepositories, TransactionsUnsupportedError } from "../src/mongo/index";
import { mgplDb } from "../src/adapters/fastify";
import { attachDb, dbErrorHandler } from "../src/adapters/express";
import { graphqlSuite } from "./graphql-suite";

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
  await contract(mongo);
  await graphqlSuite(mongo, ok);

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
  const pgdb = await createDb({ backend: "pg", pg: { url: "postgres://postgres:postgres@localhost:54329/mgpl_test" } });
  await contract(pgdb);
  await graphqlSuite(pgdb, ok);

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
