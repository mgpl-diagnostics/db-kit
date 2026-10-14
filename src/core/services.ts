import { defaultPostingHook } from "./accounting";
import { computeTotals, type ItemInput } from "./money";
import { counterKeys, dayKey, financialYear, formatBookingNo, formatInvoiceNo, formatSampleBarcode, formatUhid } from "./numbering";
import { ConflictError, NotFoundError, ValidationError, type Repositories } from "./ports";
import type {
  Booking, BookingTest, Branch, CollectionType, Id, Invoice, InvoiceStatus, Organization, Patient, Payment, PaymentMode,
  Paise, Report, ReportStatus, ResultValue, Sample, User,
} from "./types";

/**
 * Workflows written once against the repository interface, so they behave identically on
 * MongoDB and PostgreSQL. Each one that touches several records runs in a transaction.
 */

// ------------------------------------------------------------------ setup

export interface SeedInput {
  org: Pick<Organization, "name" | "code"> & Partial<Omit<Organization, "id" | "createdAt" | "updatedAt">>;
  branch: Pick<Branch, "code" | "name"> & Partial<Pick<Branch, "kind" | "phone" | "gstin" | "stateCode" | "address">>;
  /** Hash the password with @mgpl-diagnostics/auth-kit (hashPassword) before calling. */
  owner: { name: string; email: string; passwordHash: string; phone?: string };
  /** Roles to create, e.g. SYSTEM_ROLES from auth-kit. The owner gets "owner". */
  roles?: { key: string; name: string; permissions: string[] }[];
}

/** Creates an organisation with its roles, its first branch and an owner account. */
export async function seedOrganization(repos: Repositories, input: SeedInput) {
  const passwordHash = input.owner.passwordHash;
  const roles = input.roles ?? [{ key: "owner", name: "Owner", permissions: ["*:*"] }];
  return repos.transaction(async (tx) => {
    const org = await tx.orgs.create({ settings: {}, ...input.org });
    for (const r of roles) await tx.roles.create({ orgId: org.id, key: r.key, name: r.name, permissions: r.permissions, system: true });
    const branch = await tx.branches.create({ orgId: org.id, kind: "lab", active: true, ...input.branch });
    const owner = await tx.users.create({
      orgId: org.id,
      name: input.owner.name,
      email: input.owner.email.trim().toLowerCase(),
      phone: input.owner.phone,
      passwordHash,
      status: "active",
      roles: [{ role: "owner", branchId: null }],
      lastLoginAt: null,
    });
    await tx.audit.log({ orgId: org.id, userId: owner.id, action: "org.seed", entity: "organization", entityId: org.id });
    return { org, branch, owner };
  });
}

export async function createUser(
  repos: Repositories,
  input: Pick<User, "orgId" | "name" | "email" | "roles" | "passwordHash"> & { phone?: string },
  actorId?: Id,
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (await repos.users.findByEmail(input.orgId, email)) throw new ConflictError(`User ${email} already exists`);
  const user = await repos.users.create({
    orgId: input.orgId, name: input.name, email, phone: input.phone, roles: input.roles,
    passwordHash: input.passwordHash, status: "active", lastLoginAt: null,
  });
  await repos.audit.log({ orgId: input.orgId, userId: actorId ?? null, action: "user.create", entity: "user", entityId: user.id });
  return user;
}

// ------------------------------------------------------------------ patients & bookings

export async function registerPatient(
  repos: Repositories,
  input: Omit<Patient, "id" | "uhid" | "createdAt" | "updatedAt">,
  actorId?: Id,
): Promise<Patient> {
  const org = await repos.orgs.get(input.orgId);
  if (!org) throw new NotFoundError("Organization", input.orgId);
  const seq = await repos.counters.next(counterKeys.uhid(org.id));
  const patient = await repos.patients.create({ ...input, uhid: formatUhid(org.code, seq) });
  await repos.audit.log({ orgId: org.id, branchId: input.branchId, userId: actorId ?? null, action: "patient.create", entity: "patient", entityId: patient.id });
  return patient;
}

export interface BookingInput {
  orgId: Id;
  branchId: Id;
  patientId: Id;
  doctorId?: Id | null;
  tests: BookingTest[];
  sampleCollection?: { type: CollectionType; scheduledAt?: Date | null };
  notes?: string;
}

/** Creates a booking and one sample (barcode) per distinct sample type. */
export async function createBooking(repos: Repositories, input: BookingInput, actorId?: Id): Promise<{ booking: Booking; samples: Sample[] }> {
  if (!input.tests.length) throw new ValidationError("A booking needs at least one test");
  const branch = await repos.branches.get(input.branchId);
  if (!branch) throw new NotFoundError("Branch", input.branchId);
  const now = new Date();
  return repos.transaction(async (tx) => {
    const day = dayKey(now);
    const seq = await tx.counters.next(counterKeys.booking(input.orgId, branch.code, day));
    const booking = await tx.bookings.create({
      orgId: input.orgId, branchId: input.branchId, patientId: input.patientId, doctorId: input.doctorId ?? null,
      bookingNo: formatBookingNo(branch.code, day, seq), tests: input.tests,
      sampleCollection: input.sampleCollection ?? { type: "walk_in" }, status: "booked", invoiceId: null, createdBy: actorId ?? null, notes: input.notes,
    });
    const samples: Sample[] = [];
    for (const type of new Set(input.tests.map((t) => t.sampleType ?? "OTHER"))) {
      const n = await tx.counters.next(counterKeys.sample(input.orgId));
      samples.push(await tx.samples.create({
        orgId: input.orgId, branchId: input.branchId, bookingId: booking.id, sampleType: type, status: "pending",
        barcode: formatSampleBarcode(day.slice(0, 2), n), collectedAt: null, collectedBy: null, receivedAt: null, rejectReason: null,
      }));
    }
    await tx.audit.log({ orgId: input.orgId, branchId: input.branchId, userId: actorId ?? null, action: "booking.create", entity: "booking", entityId: booking.id });
    return { booking, samples };
  });
}

// ------------------------------------------------------------------ reports

const REPORT_FLOW: Record<ReportStatus, ReportStatus[]> = {
  draft: ["entered"],
  entered: ["entered", "verified", "draft"],
  verified: ["released", "entered"],
  released: ["amended"],
  amended: ["verified"],
};

export async function saveResults(repos: Repositories, reportId: Id, results: ResultValue[], actorId: Id): Promise<Report> {
  return transitionReport(repos, reportId, "entered", actorId, { results });
}

/** Moves a report along draft → entered → verified → released (→ amended → verified …). */
export async function transitionReport(
  repos: Repositories,
  reportId: Id,
  to: ReportStatus,
  actorId: Id,
  extra: Partial<Pick<Report, "results">> = {},
): Promise<Report> {
  const report = await repos.reports.get(reportId);
  if (!report) throw new NotFoundError("Report", reportId);
  if (!REPORT_FLOW[report.status].includes(to)) throw new ConflictError(`Report cannot go from ${report.status} to ${to}`);
  const now = new Date();
  const patch: Partial<Report> = { status: to, ...extra };
  if (to === "entered") patch.enteredBy = actorId;
  if (to === "verified") Object.assign(patch, { verifiedBy: actorId, verifiedAt: now });
  if (to === "released") patch.releasedAt = now;
  if (to === "amended") patch.version = report.version + 1;
  const updated = await repos.reports.update(reportId, patch);
  await repos.audit.log({ orgId: report.orgId, branchId: report.branchId, userId: actorId, action: `report.${to}`, entity: "report", entityId: reportId });
  return updated!;
}

// ------------------------------------------------------------------ billing

export interface IssueInvoiceInput {
  orgId: Id;
  branchId: Id;
  patientId: Id;
  bookingId?: Id | null;
  /** B2B customer billed; finance-kit's issueCustomerInvoice fills these three. */
  customerId?: Id | null;
  placeOfSupply?: string | null;
  buyerGstin?: string | null;
  items: ItemInput[];
  billDiscountPaise?: Paise;
  /** Payments taken at the counter together with the invoice. */
  payments?: { amountPaise: Paise; mode: PaymentMode; reference?: string }[];
  date?: Date;
}

const statusFor = (total: Paise, paid: Paise): InvoiceStatus => (paid >= total ? "paid" : paid > 0 ? "partially_paid" : "issued");

/** Amount due and status after a payment, refund or credit note. Credit notes reduce what is owed. */
export function invoiceBalance(inv: Pick<Invoice, "totalPaise" | "creditedPaise">, paidPaise: Paise, refund = false): { duePaise: Paise; status: InvoiceStatus } {
  const credited = inv.creditedPaise ?? 0;
  const net = inv.totalPaise - credited;
  const duePaise = Math.max(0, net - paidPaise);
  if (refund && paidPaise === 0) return { duePaise, status: "refunded" };
  if (credited > 0 && net <= 0 && paidPaise <= 0) return { duePaise, status: "credited" };
  return { duePaise, status: statusFor(net, paidPaise) };
}

const postingOf = (tx: Repositories) => tx.posting ?? defaultPostingHook;

/** Numbers the invoice in the branch's financial-year series, stores it, links the booking, takes payments. */
export async function issueInvoice(repos: Repositories, input: IssueInvoiceInput, actorId?: Id): Promise<{ invoice: Invoice; payments: Payment[] }> {
  const [org, branch] = await Promise.all([repos.orgs.get(input.orgId), repos.branches.get(input.branchId)]);
  if (!org) throw new NotFoundError("Organization", input.orgId);
  if (!branch) throw new NotFoundError("Branch", input.branchId);
  const { items, totals } = computeTotals(input.items, input.billDiscountPaise);
  const when = input.date ?? new Date();
  const paid = (input.payments ?? []).reduce((s, p) => s + p.amountPaise, 0);
  if (paid > totals.totalPaise) throw new ConflictError("Payments exceed the invoice total");

  return repos.transaction(async (tx) => {
    const fy = financialYear(when);
    const seq = await tx.counters.next(counterKeys.invoice(org.id, branch.code, fy));
    const invoice = await tx.invoices.create({
      orgId: org.id, branchId: branch.id, patientId: input.patientId, bookingId: input.bookingId ?? null,
      customerId: input.customerId ?? null, placeOfSupply: input.placeOfSupply ?? null, buyerGstin: input.buyerGstin ?? null,
      invoiceNo: formatInvoiceNo(org.code, branch.code, fy, seq), items, ...totals,
      paidPaise: paid, creditedPaise: 0, duePaise: totals.totalPaise - paid, status: statusFor(totals.totalPaise, paid),
      issuedAt: when, createdBy: actorId ?? null, cancelReason: null,
    });
    const payments: Payment[] = [];
    for (const p of input.payments ?? [])
      payments.push(await tx.payments.create({
        orgId: org.id, branchId: branch.id, invoiceId: invoice.id, kind: "payment", amountPaise: p.amountPaise,
        mode: p.mode, reference: p.reference, receivedBy: actorId ?? null, receivedAt: when,
      }));
    if (input.bookingId) await tx.bookings.update(input.bookingId, { invoiceId: invoice.id });
    // books: sales voucher, then a receipt per payment (the default hook skips them without a chart of accounts)
    const posting = postingOf(tx);
    await posting.invoiceIssued(tx, invoice, actorId);
    for (const p of payments) await posting.paymentRecorded(tx, p, invoice.invoiceNo, actorId);
    await tx.audit.log({ orgId: org.id, branchId: branch.id, userId: actorId ?? null, action: "invoice.issue", entity: "invoice", entityId: invoice.id, data: { invoiceNo: invoice.invoiceNo, totalPaise: invoice.totalPaise } });
    return { invoice, payments };
  });
}

/** Adds a payment or refund. Locks the invoice, so concurrent payments cannot lose updates. */
export async function recordPayment(
  repos: Repositories,
  input: { invoiceId: Id; amountPaise: Paise; mode: PaymentMode; kind?: "payment" | "refund"; reference?: string },
  actorId?: Id,
): Promise<{ invoice: Invoice; payment: Payment }> {
  if (!(input.amountPaise > 0)) throw new ValidationError("Amount must be positive");
  const kind = input.kind ?? "payment";
  return repos.transaction(async (tx) => {
    const inv = await tx.invoices.getForUpdate(input.invoiceId);
    if (!inv) throw new NotFoundError("Invoice", input.invoiceId);
    if (inv.status === "cancelled") throw new ConflictError("Invoice is cancelled");
    if (kind === "payment" && input.amountPaise > inv.duePaise) throw new ConflictError(`Payment exceeds the amount due (${inv.duePaise} paise)`);
    if (kind === "refund" && input.amountPaise > inv.paidPaise) throw new ConflictError(`Refund exceeds the amount paid (${inv.paidPaise} paise)`);
    const payment = await tx.payments.create({
      orgId: inv.orgId, branchId: inv.branchId, invoiceId: inv.id, kind, amountPaise: input.amountPaise,
      mode: input.mode, reference: input.reference, receivedBy: actorId ?? null, receivedAt: new Date(),
    });
    const paid = inv.paidPaise + (kind === "payment" ? input.amountPaise : -input.amountPaise);
    const invoice = (await tx.invoices.update(inv.id, { paidPaise: paid, ...invoiceBalance(inv, paid, kind === "refund") }))!;
    await postingOf(tx).paymentRecorded(tx, payment, inv.invoiceNo, actorId);
    await tx.audit.log({ orgId: inv.orgId, branchId: inv.branchId, userId: actorId ?? null, action: `payment.${kind}`, entity: "invoice", entityId: inv.id, data: { amountPaise: input.amountPaise, mode: input.mode } });
    return { invoice, payment };
  });
}

/** Cancels an unpaid invoice. A paid one must be refunded first. */
export async function cancelInvoice(repos: Repositories, invoiceId: Id, reason: string, actorId?: Id): Promise<Invoice> {
  return repos.transaction(async (tx) => {
    const inv = await tx.invoices.getForUpdate(invoiceId);
    if (!inv) throw new NotFoundError("Invoice", invoiceId);
    if (inv.status === "cancelled") return inv;
    if (inv.paidPaise > 0) throw new ConflictError("Refund the payments before cancelling");
    const invoice = (await tx.invoices.update(invoiceId, { status: "cancelled", cancelReason: reason, duePaise: 0 }))!;
    if (inv.bookingId) await tx.bookings.update(inv.bookingId, { invoiceId: null });
    await postingOf(tx).invoiceCancelled(tx, invoiceId, actorId);
    await tx.audit.log({ orgId: inv.orgId, branchId: inv.branchId, userId: actorId ?? null, action: "invoice.cancel", entity: "invoice", entityId: invoiceId, data: { reason } });
    return invoice;
  });
}
