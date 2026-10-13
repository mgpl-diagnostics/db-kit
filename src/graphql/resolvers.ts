import { GraphQLScalarType, Kind } from "graphql";
import { cancelVoucher, postVoucher, seedChartOfAccounts } from "../core/accounting";
import { ConflictError, ValidationError, type Repo } from "../core/ports";
import {
  balanceSheet, dayBook, gstSummary, ledgerBalance, ledgerStatement, outstandingReceivables, profitAndLoss, trialBalance,
} from "../core/reports";
import {
  cancelInvoice, createBooking, issueInvoice, recordPayment, registerPatient, saveResults, transitionReport,
} from "../core/services";
import type {
  AccountGroup, Booking, Id, Invoice, Ledger, Patient, Report, ResultValue, Sample, Voucher, VoucherEntry,
} from "../core/types";
import { authorize, branchScope, load, loaders, notFound, own, viewerOf, withErrorCodes, type DbGraphQLContext as Ctx } from "./context";

// ------------------------------------------------------------------ scalars & enum mapping

const DateTime = new GraphQLScalarType({
  name: "DateTime",
  description: "ISO-8601 date-time",
  serialize: (v) => (v instanceof Date ? v : new Date(v as string)).toISOString(),
  parseValue: (v) => {
    const d = new Date(v as string);
    if (Number.isNaN(d.getTime())) throw new TypeError("Invalid DateTime");
    return d;
  },
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? new Date(ast.value) : null),
});

const JSONScalar = new GraphQLScalarType({ name: "JSON", serialize: (v) => v, parseValue: (v) => v });

const flagOut = (f: ResultValue["flag"]) => (f === "" ? "NONE" : f ?? null);
const flagIn = (f?: string | null): ResultValue["flag"] => (f === "NONE" ? "" : ((f ?? undefined) as ResultValue["flag"]));
const BUCKET = { "0-30": "D0_30", "31-60": "D31_60", "61-90": "D61_90", "90+": "D90_PLUS" } as const;

const clean = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
const cap = (n: number | undefined, d: number) => Math.min(Math.max(1, n ?? d), 200);

/** Lists honour the viewer's branch access: all branches, or only the allowed ones. */
async function scopedFind<T extends { id: Id }>(repo: Repo<T>, filter: Record<string, unknown>, scope: "all" | Id[], limit: number, offset: number, sortField: string): Promise<T[]> {
  const sort = { field: sortField as keyof T & string, dir: "desc" as const };
  if (scope === "all") return repo.find(filter as any, { limit, offset, sort });
  const lists = await Promise.all(scope.map((b) => repo.find({ ...filter, branchId: b } as any, { limit: limit + offset, sort })));
  return lists.flat().sort((a: any, b: any) => +b[sortField] - +a[sortField]).slice(offset, offset + limit);
}

async function ownLedgers(ctx: Ctx, ids: Id[]): Promise<void> {
  const v = viewerOf(ctx);
  const found = await ctx.repos.ledgers.getMany([...new Set(ids)]);
  if (found.length !== new Set(ids).size || found.some((l) => l.orgId !== v.orgId)) throw notFound("Ledger");
}

const canSee = async (ctx: Ctx, permission: string, branchId?: Id | null) => Boolean(ctx.viewer && (await ctx.can(permission, branchId)));

// ------------------------------------------------------------------ resolvers

export const resolvers = withErrorCodes({
  Query: {
    organization: async (_: unknown, __: unknown, ctx: Ctx) => ctx.repos.orgs.get(viewerOf(ctx).orgId),
    branches: async (_: unknown, __: unknown, ctx: Ctx) => ctx.repos.branches.find({ orgId: viewerOf(ctx).orgId }, { sort: { field: "code" } }),

    patient: async (_: unknown, a: { id: Id }, ctx: Ctx) => {
      await authorize(ctx, "patient:read");
      return own(ctx, await ctx.repos.patients.get(a.id));
    },
    patients: async (_: unknown, a: { search: string; limit?: number }, ctx: Ctx) => {
      const v = await authorize(ctx, "patient:read");
      return ctx.repos.patients.search(v.orgId, a.search, cap(a.limit, 20));
    },
    doctors: async (_: unknown, __: unknown, ctx: Ctx) => {
      const v = await authorize(ctx, "doctor:read");
      return ctx.repos.doctors.find({ orgId: v.orgId }, { sort: { field: "name" } });
    },

    booking: async (_: unknown, a: { id: Id }, ctx: Ctx) => load(ctx, "Booking", () => ctx.repos.bookings.get(a.id), "booking:read"),
    bookings: async (_: unknown, a: { branchId?: Id; status?: string; patientId?: Id; limit?: number; offset?: number }, ctx: Ctx) => {
      const scope = await branchScope(ctx, "booking:read", a.branchId);
      return scopedFind(ctx.repos.bookings, clean({ orgId: viewerOf(ctx).orgId, status: a.status, patientId: a.patientId }), scope, cap(a.limit, 50), a.offset ?? 0, "createdAt");
    },
    sampleByBarcode: async (_: unknown, a: { barcode: string }, ctx: Ctx) => {
      const v = viewerOf(ctx);
      const s = await ctx.repos.samples.findOne({ orgId: v.orgId, barcode: a.barcode.trim() });
      if (!s) return null;
      await authorize(ctx, "sample:read", s.branchId);
      return s;
    },
    report: async (_: unknown, a: { id: Id }, ctx: Ctx) => load(ctx, "Report", () => ctx.repos.reports.get(a.id), "report:read"),
    invoice: async (_: unknown, a: { id: Id }, ctx: Ctx) => load(ctx, "Invoice", () => ctx.repos.invoices.get(a.id), "invoice:read"),
    invoices: async (_: unknown, a: { branchId?: Id; status?: string; patientId?: Id; limit?: number; offset?: number }, ctx: Ctx) => {
      const scope = await branchScope(ctx, "invoice:read", a.branchId);
      return scopedFind(ctx.repos.invoices, clean({ orgId: viewerOf(ctx).orgId, status: a.status, patientId: a.patientId }), scope, cap(a.limit, 50), a.offset ?? 0, "createdAt");
    },

    accountGroups: async (_: unknown, __: unknown, ctx: Ctx) => ctx.repos.accountGroups.find({ orgId: (await authorize(ctx, "accounts:read")).orgId }, { sort: { field: "name" } }),
    ledgers: async (_: unknown, __: unknown, ctx: Ctx) => ctx.repos.ledgers.find({ orgId: (await authorize(ctx, "accounts:read")).orgId }, { sort: { field: "name" } }),
    ledgerStatement: async (_: unknown, a: { ledgerId: Id; from: Date; to: Date; branchId?: Id }, ctx: Ctx) => {
      const v = await authorize(ctx, "accounts:read", a.branchId);
      await ownLedgers(ctx, [a.ledgerId]);
      return ledgerStatement(ctx.repos, { orgId: v.orgId, ...a });
    },
    trialBalance: async (_: unknown, a: { asOf?: Date; branchId?: Id }, ctx: Ctx) => trialBalance(ctx.repos, { orgId: (await authorize(ctx, "accounts:read", a.branchId)).orgId, ...a }),
    profitAndLoss: async (_: unknown, a: { from: Date; to: Date; branchId?: Id }, ctx: Ctx) => profitAndLoss(ctx.repos, { orgId: (await authorize(ctx, "accounts:read", a.branchId)).orgId, ...a }),
    balanceSheet: async (_: unknown, a: { asOf: Date; branchId?: Id }, ctx: Ctx) => balanceSheet(ctx.repos, { orgId: (await authorize(ctx, "accounts:read", a.branchId)).orgId, ...a }),
    dayBook: async (_: unknown, a: { from: Date; to: Date; branchId?: Id; type?: Voucher["type"] }, ctx: Ctx) => dayBook(ctx.repos, { orgId: (await authorize(ctx, "accounts:read", a.branchId)).orgId, ...a }),
    outstandingReceivables: async (_: unknown, a: { branchId?: Id }, ctx: Ctx) => {
      const out = await outstandingReceivables(ctx.repos, { orgId: (await authorize(ctx, "accounts:read", a.branchId)).orgId, branchId: a.branchId });
      return {
        rows: out.rows.map((r) => ({ ...r, bucket: BUCKET[r.bucket] })),
        buckets: { d0to30: out.buckets["0-30"], d31to60: out.buckets["31-60"], d61to90: out.buckets["61-90"], d90plus: out.buckets["90+"] },
        totalDuePaise: out.totalDuePaise,
      };
    },
    gstSummary: async (_: unknown, a: { from: Date; to: Date; branchId?: Id }, ctx: Ctx) => gstSummary(ctx.repos, { orgId: (await authorize(ctx, "accounts:read", a.branchId)).orgId, ...a }),
  },

  Organization: {
    branches: (o: { id: Id }, _: unknown, ctx: Ctx) => ctx.repos.branches.find({ orgId: o.id }, { sort: { field: "code" } }),
  },
  Patient: {
    branch: (p: Patient, _: unknown, ctx: Ctx) => loaders(ctx).branch.load(p.branchId),
    bookings: async (p: Patient, a: { limit?: number }, ctx: Ctx) => {
      if (!(await canSee(ctx, "booking:read"))) return [];
      const scope = await ctx.branchesFor("booking:read");
      return scopedFind(ctx.repos.bookings, { patientId: p.id }, scope, cap(a.limit, 20), 0, "createdAt");
    },
    invoices: async (p: Patient, a: { limit?: number }, ctx: Ctx) => {
      if (!(await canSee(ctx, "invoice:read"))) return [];
      const scope = await ctx.branchesFor("invoice:read");
      return scopedFind(ctx.repos.invoices, { patientId: p.id }, scope, cap(a.limit, 20), 0, "createdAt");
    },
  },
  Booking: {
    patient: (b: Booking, _: unknown, ctx: Ctx) => loaders(ctx).patient.load(b.patientId),
    doctor: (b: Booking, _: unknown, ctx: Ctx) => loaders(ctx).doctor.load(b.doctorId),
    branch: (b: Booking, _: unknown, ctx: Ctx) => loaders(ctx).branch.load(b.branchId),
    samples: (b: Booking, _: unknown, ctx: Ctx) => ctx.repos.samples.find({ bookingId: b.id }, { sort: { field: "barcode" } }),
    reports: async (b: Booking, _: unknown, ctx: Ctx) => ((await canSee(ctx, "report:read", b.branchId)) ? ctx.repos.reports.find({ bookingId: b.id }) : []),
    invoice: async (b: Booking, _: unknown, ctx: Ctx) => ((await canSee(ctx, "invoice:read", b.branchId)) ? loaders(ctx).invoice.load(b.invoiceId) : null),
  },
  Report: {
    results: (r: Report) => r.results.map((x) => ({ ...x, flag: flagOut(x.flag) })),
    patient: (r: Report, _: unknown, ctx: Ctx) => loaders(ctx).patient.load(r.patientId),
    booking: (r: Report, _: unknown, ctx: Ctx) => loaders(ctx).booking.load(r.bookingId),
  },
  Invoice: {
    patient: (i: Invoice, _: unknown, ctx: Ctx) => loaders(ctx).patient.load(i.patientId),
    branch: (i: Invoice, _: unknown, ctx: Ctx) => loaders(ctx).branch.load(i.branchId),
    booking: (i: Invoice, _: unknown, ctx: Ctx) => loaders(ctx).booking.load(i.bookingId),
    payments: (i: Invoice, _: unknown, ctx: Ctx) => ctx.repos.payments.find({ invoiceId: i.id }, { sort: { field: "receivedAt" } }),
    vouchers: async (i: Invoice, _: unknown, ctx: Ctx) => ((await canSee(ctx, "accounts:read", i.branchId)) ? ctx.repos.vouchers.find({ invoiceId: i.id } as any, { sort: { field: "date" } }) : []),
  },
  AccountGroup: {
    parent: (g: AccountGroup, _: unknown, ctx: Ctx) => loaders(ctx).group.load(g.parentId),
  },
  Ledger: {
    group: (l: Ledger, _: unknown, ctx: Ctx) => loaders(ctx).group.load(l.groupId),
    balancePaise: (l: Ledger, a: { asOf?: Date; branchId?: Id }, ctx: Ctx) => ledgerBalance(ctx.repos, { orgId: l.orgId, ledgerId: l.id, ...a }),
  },
  VoucherEntry: {
    ledger: (e: VoucherEntry, _: unknown, ctx: Ctx) => loaders(ctx).ledger.load(e.ledgerId),
  },

  Mutation: {
    registerPatient: async (_: unknown, { input }: { input: any }, ctx: Ctx) => {
      const v = await authorize(ctx, "patient:create", input.branchId);
      if (!own(ctx, await ctx.repos.branches.get(input.branchId))) throw notFound("Branch");
      return registerPatient(ctx.repos, { ...input, orgId: v.orgId }, v.userId);
    },
    updatePatient: async (_: unknown, { id, input }: { id: Id; input: any }, ctx: Ctx) => {
      const v = await authorize(ctx, "patient:update");
      if (!own(ctx, await ctx.repos.patients.get(id))) throw notFound("Patient");
      const p = await ctx.repos.patients.update(id, clean(input));
      await ctx.repos.audit.log({ orgId: v.orgId, userId: v.userId, action: "patient.update", entity: "patient", entityId: id });
      return p;
    },
    createDoctor: async (_: unknown, { input }: { input: any }, ctx: Ctx) => {
      const v = await authorize(ctx, "doctor:manage");
      return ctx.repos.doctors.create({ ...input, orgId: v.orgId, active: input.active ?? true });
    },

    createBooking: async (_: unknown, { input }: { input: any }, ctx: Ctx) => {
      const v = await authorize(ctx, "booking:create", input.branchId);
      if (!own(ctx, await ctx.repos.branches.get(input.branchId))) throw notFound("Branch");
      if (!own(ctx, await ctx.repos.patients.get(input.patientId))) throw notFound("Patient");
      if (input.doctorId && !own(ctx, await ctx.repos.doctors.get(input.doctorId))) throw notFound("Doctor");
      return createBooking(ctx.repos, {
        orgId: v.orgId, branchId: input.branchId, patientId: input.patientId, doctorId: input.doctorId ?? null, tests: input.tests,
        sampleCollection: { type: input.collectionType ?? "walk_in", scheduledAt: input.scheduledAt ?? null }, notes: input.notes,
      }, v.userId);
    },
    cancelBooking: async (_: unknown, { id }: { id: Id }, ctx: Ctx) => {
      const b = await load(ctx, "Booking", () => ctx.repos.bookings.get(id), "booking:cancel");
      if (b.invoiceId) {
        const inv = await ctx.repos.invoices.get(b.invoiceId);
        if (inv && inv.status !== "cancelled") throw new ConflictError("Cancel the booking's invoice first");
      }
      const out = await ctx.repos.bookings.update(id, { status: "cancelled" });
      await ctx.repos.audit.log({ orgId: b.orgId, branchId: b.branchId, userId: ctx.viewer!.userId, action: "booking.cancel", entity: "booking", entityId: id });
      return out;
    },
    collectSample: async (_: unknown, { id }: { id: Id }, ctx: Ctx) => {
      const s = await load<Sample>(ctx, "Sample", () => ctx.repos.samples.get(id), "sample:collect");
      if (s.status !== "pending") throw new ConflictError(`Sample is ${s.status}`);
      const out = await ctx.repos.samples.update(id, { status: "collected", collectedAt: new Date(), collectedBy: ctx.viewer!.userId });
      const b = await ctx.repos.bookings.get(s.bookingId);
      if (b?.status === "booked") await ctx.repos.bookings.update(b.id, { status: "sample_collected" });
      return out;
    },
    receiveSample: async (_: unknown, { id }: { id: Id }, ctx: Ctx) => {
      const s = await load<Sample>(ctx, "Sample", () => ctx.repos.samples.get(id), "sample:receive");
      if (s.status !== "collected") throw new ConflictError(`Sample is ${s.status}`);
      const out = await ctx.repos.samples.update(id, { status: "received", receivedAt: new Date() });
      await ctx.repos.bookings.update(s.bookingId, { status: "in_process" });
      return out;
    },
    rejectSample: async (_: unknown, { id, reason }: { id: Id; reason: string }, ctx: Ctx) => {
      await load<Sample>(ctx, "Sample", () => ctx.repos.samples.get(id), "sample:reject");
      return ctx.repos.samples.update(id, { status: "rejected", rejectReason: reason });
    },

    createReport: async (_: unknown, a: { bookingId: Id; testCode: string; testName: string }, ctx: Ctx) => {
      const b = await load(ctx, "Booking", () => ctx.repos.bookings.get(a.bookingId), "report:enter");
      if (!b.tests.some((t) => t.testCode === a.testCode)) throw new ValidationError(`Test ${a.testCode} is not in booking ${b.bookingNo}`);
      return ctx.repos.reports.create({ orgId: b.orgId, branchId: b.branchId, bookingId: b.id, patientId: b.patientId, testCode: a.testCode, testName: a.testName, results: [], status: "draft", version: 1 });
    },
    saveResults: async (_: unknown, a: { reportId: Id; results: any[] }, ctx: Ctx) => {
      await load(ctx, "Report", () => ctx.repos.reports.get(a.reportId), "report:enter");
      return saveResults(ctx.repos, a.reportId, a.results.map((r) => ({ ...r, flag: flagIn(r.flag) })), ctx.viewer!.userId);
    },
    verifyReport: async (_: unknown, { id }: { id: Id }, ctx: Ctx) => {
      await load(ctx, "Report", () => ctx.repos.reports.get(id), "report:verify");
      return transitionReport(ctx.repos, id, "verified", ctx.viewer!.userId);
    },
    releaseReport: async (_: unknown, { id }: { id: Id }, ctx: Ctx) => {
      const r = await load(ctx, "Report", () => ctx.repos.reports.get(id), "report:release");
      const out = await transitionReport(ctx.repos, id, "released", ctx.viewer!.userId);
      const all = await ctx.repos.reports.find({ bookingId: r.bookingId });
      if (all.every((x) => x.status === "released")) await ctx.repos.bookings.update(r.bookingId, { status: "completed" });
      return out;
    },
    amendReport: async (_: unknown, { id }: { id: Id }, ctx: Ctx) => {
      await load(ctx, "Report", () => ctx.repos.reports.get(id), "report:amend");
      return transitionReport(ctx.repos, id, "amended", ctx.viewer!.userId);
    },

    issueInvoice: async (_: unknown, { input }: { input: any }, ctx: Ctx) => {
      const v = await authorize(ctx, "invoice:create", input.branchId);
      const discounted = (input.billDiscountPaise ?? 0) > 0 || input.items.some((i: any) => (i.discountPaise ?? 0) > 0);
      if (discounted) await authorize(ctx, "invoice:discount", input.branchId);
      if (input.payments?.length) await authorize(ctx, "payment:create", input.branchId);
      if (!own(ctx, await ctx.repos.branches.get(input.branchId))) throw notFound("Branch");
      if (!own(ctx, await ctx.repos.patients.get(input.patientId))) throw notFound("Patient");
      if (input.bookingId && !own(ctx, await ctx.repos.bookings.get(input.bookingId))) throw notFound("Booking");
      const { invoice } = await issueInvoice(ctx.repos, { ...input, orgId: v.orgId }, v.userId);
      return invoice;
    },
    recordPayment: async (_: unknown, a: { invoiceId: Id; payment: any }, ctx: Ctx) => {
      await load(ctx, "Invoice", () => ctx.repos.invoices.get(a.invoiceId), "payment:create");
      return (await recordPayment(ctx.repos, { invoiceId: a.invoiceId, ...a.payment, kind: "payment" }, ctx.viewer!.userId)).invoice;
    },
    refundPayment: async (_: unknown, a: { invoiceId: Id; payment: any }, ctx: Ctx) => {
      await load(ctx, "Invoice", () => ctx.repos.invoices.get(a.invoiceId), "payment:refund");
      return (await recordPayment(ctx.repos, { invoiceId: a.invoiceId, ...a.payment, kind: "refund" }, ctx.viewer!.userId)).invoice;
    },
    cancelInvoice: async (_: unknown, a: { id: Id; reason: string }, ctx: Ctx) => {
      await load(ctx, "Invoice", () => ctx.repos.invoices.get(a.id), "invoice:cancel");
      return cancelInvoice(ctx.repos, a.id, a.reason, ctx.viewer!.userId);
    },

    setupChartOfAccounts: async (_: unknown, __: unknown, ctx: Ctx) => (await seedChartOfAccounts(ctx.repos, (await authorize(ctx, "accounts:manage")).orgId)).ledgers,
    createLedger: async (_: unknown, { input }: { input: any }, ctx: Ctx) => {
      const v = await authorize(ctx, "accounts:manage");
      if (!own(ctx, await ctx.repos.accountGroups.get(input.groupId))) throw notFound("Account group");
      return ctx.repos.ledgers.create({ orgId: v.orgId, name: input.name, groupId: input.groupId, openingPaise: input.openingPaise ?? 0, gstin: input.gstin, systemKey: null, active: true });
    },
    postVoucher: async (_: unknown, { input }: { input: any }, ctx: Ctx) => {
      const v = await authorize(ctx, "accounts:post", input.branchId);
      if (!own(ctx, await ctx.repos.branches.get(input.branchId))) throw notFound("Branch");
      await ownLedgers(ctx, input.entries.map((e: VoucherEntry) => e.ledgerId)); // no posting into another organisation's books
      for (const e of input.entries) if (e.invoiceId && !own(ctx, await ctx.repos.invoices.get(e.invoiceId))) throw notFound("Invoice");
      return postVoucher(ctx.repos, { ...input, orgId: v.orgId, entries: input.entries.map((e: any) => ({ ...e, debitPaise: e.debitPaise ?? 0, creditPaise: e.creditPaise ?? 0 })) }, v.userId);
    },
    cancelVoucher: async (_: unknown, { id }: { id: Id }, ctx: Ctx) => {
      await load(ctx, "Voucher", () => ctx.repos.vouchers.get(id), "accounts:post");
      return cancelVoucher(ctx.repos, id, ctx.viewer!.userId);
    },
  },
});

// scalars are added after wrapping (they are not functions to wrap)
Object.assign(resolvers, { DateTime, JSON: JSONScalar });
