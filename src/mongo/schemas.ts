import { randomUUID } from "node:crypto";
import { Schema, type Connection, type Model } from "mongoose";

/**
 * Mongoose schemas. Ids are UUID strings (same as PostgreSQL), stored in _id and exposed as `id`.
 * Every query the repositories run is backed by an index declared here.
 */

const uuid = { type: String, default: () => randomUUID() };
const opts = { versionKey: false, timestamps: true } as const;
const sub = { _id: false } as const;

const Address = new Schema({ line1: String, line2: String, city: String, district: String, state: String, pincode: String }, sub);
const RoleAssignment = new Schema({ role: { type: String, required: true }, branchId: { type: String, default: null } }, sub);
const BookingTest = new Schema({ testCode: { type: String, required: true }, name: { type: String, required: true }, pricePaise: { type: Number, required: true, min: 0 }, sampleType: String }, sub);
const ResultValue = new Schema({ parameter: { type: String, required: true }, value: { type: String, default: "" }, unit: String, flag: { type: String, enum: ["L", "H", "A", ""] }, range: String }, sub);
const TAXABILITY = ["taxable", "exempt", "nil_rated", "non_gst"];
const CATEGORIES = ["test", "package", "service", "consumable", "medicine", "other"];
const InvoiceItem = new Schema(
  {
    code: String,
    name: { type: String, required: true },
    category: { type: String, enum: CATEGORIES, default: "test" },
    qty: { type: Number, required: true, min: 0 },
    ratePaise: { type: Number, required: true, min: 0 },
    discountPaise: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },
    hsnSac: String,
    taxability: { type: String, enum: TAXABILITY },
    amountPaise: { type: Number, required: true },
  },
  sub,
);

export const schemas = {
  Organization: new Schema(
    { _id: uuid, name: { type: String, required: true }, legalName: String, gstin: String, phone: String, email: String, address: Address, code: { type: String, required: true, unique: true, uppercase: true, trim: true }, settings: { type: Schema.Types.Mixed, default: {} } },
    opts,
  ),

  Branch: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, code: { type: String, required: true, uppercase: true, trim: true }, name: { type: String, required: true }, kind: { type: String, enum: ["lab", "collection_center"], default: "lab" }, phone: String, gstin: String, stateCode: String, address: Address, active: { type: Boolean, default: true } },
    opts,
  ).index({ orgId: 1, code: 1 }, { unique: true }),

  User: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, name: { type: String, required: true }, email: { type: String, required: true, lowercase: true, trim: true }, phone: String, passwordHash: { type: String, required: true }, status: { type: String, enum: ["active", "disabled", "invited"], default: "active" }, roles: { type: [RoleAssignment], default: [] }, lastLoginAt: { type: Date, default: null } },
    opts,
  ).index({ orgId: 1, email: 1 }, { unique: true }).index({ email: 1 }),

  Role: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, key: { type: String, required: true }, name: { type: String, required: true }, permissions: { type: [String], default: [] }, system: { type: Boolean, default: false } },
    opts,
  ).index({ orgId: 1, key: 1 }, { unique: true }),

  Patient: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, uhid: { type: String, required: true }, title: String, name: { type: String, required: true, trim: true }, sex: { type: String, enum: ["male", "female", "other"], required: true }, dob: { type: Date, default: null }, ageYears: { type: Number, default: null }, phone: String, email: String, address: Address },
    opts,
  ).index({ orgId: 1, uhid: 1 }, { unique: true }).index({ orgId: 1, phone: 1 }).index({ orgId: 1, name: 1 }),

  Doctor: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, name: { type: String, required: true }, qualification: String, phone: String, clinic: String, active: { type: Boolean, default: true } },
    opts,
  ).index({ orgId: 1, name: 1 }),

  Booking: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, bookingNo: { type: String, required: true },
      patientId: { type: String, required: true }, doctorId: { type: String, default: null }, tests: { type: [BookingTest], default: [] },
      sampleCollection: { type: new Schema({ type: { type: String, enum: ["walk_in", "home"], default: "walk_in" }, scheduledAt: { type: Date, default: null }, address: Address }, sub), default: () => ({ type: "walk_in" }) },
      status: { type: String, enum: ["booked", "sample_collected", "in_process", "completed", "cancelled"], default: "booked" },
      invoiceId: { type: String, default: null }, createdBy: { type: String, default: null }, notes: String,
    },
    opts,
  ).index({ orgId: 1, bookingNo: 1 }, { unique: true }).index({ branchId: 1, createdAt: -1 }).index({ patientId: 1 }).index({ orgId: 1, status: 1 }),

  Sample: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, bookingId: { type: String, required: true }, barcode: { type: String, required: true }, sampleType: { type: String, required: true }, status: { type: String, enum: ["pending", "collected", "received", "rejected"], default: "pending" }, collectedAt: { type: Date, default: null }, collectedBy: { type: String, default: null }, receivedAt: { type: Date, default: null }, rejectReason: { type: String, default: null } },
    opts,
  ).index({ orgId: 1, barcode: 1 }, { unique: true }).index({ bookingId: 1 }),

  Report: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, bookingId: { type: String, required: true }, patientId: { type: String, required: true }, testCode: { type: String, required: true }, testName: { type: String, required: true }, results: { type: [ResultValue], default: [] }, status: { type: String, enum: ["draft", "entered", "verified", "released", "amended"], default: "draft" }, enteredBy: { type: String, default: null }, verifiedBy: { type: String, default: null }, verifiedAt: { type: Date, default: null }, releasedAt: { type: Date, default: null }, version: { type: Number, default: 1 } },
    opts,
  ).index({ bookingId: 1 }).index({ patientId: 1, createdAt: -1 }).index({ orgId: 1, status: 1 }),

  Invoice: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, invoiceNo: { type: String, required: true },
      patientId: { type: String, required: true }, bookingId: { type: String, default: null },
      customerId: { type: String, default: null }, placeOfSupply: { type: String, default: null }, buyerGstin: { type: String, default: null },
      items: { type: [InvoiceItem], default: [] },
      subtotalPaise: { type: Number, required: true }, discountPaise: { type: Number, default: 0 }, taxPaise: { type: Number, default: 0 },
      roundOffPaise: { type: Number, default: 0 }, totalPaise: { type: Number, required: true }, paidPaise: { type: Number, default: 0 },
      creditedPaise: { type: Number, default: 0 }, duePaise: { type: Number, required: true },
      status: { type: String, enum: ["draft", "issued", "partially_paid", "paid", "cancelled", "refunded", "credited"], default: "issued" },
      issuedAt: { type: Date, default: null }, createdBy: { type: String, default: null }, cancelReason: { type: String, default: null },
      /** bumped by getForUpdate to take the document's write lock inside a transaction */
      lockVersion: { type: Number, default: 0 },
    },
    opts,
  ).index({ orgId: 1, invoiceNo: 1 }, { unique: true }).index({ patientId: 1 }).index({ branchId: 1, issuedAt: -1 }).index({ orgId: 1, status: 1 })
    .index({ orgId: 1, issuedAt: 1 }).index({ customerId: 1, issuedAt: 1 }),

  Payment: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, invoiceId: { type: String, required: true }, kind: { type: String, enum: ["payment", "refund"], default: "payment" }, amountPaise: { type: Number, required: true, min: 1 }, mode: { type: String, enum: ["cash", "upi", "card", "netbanking", "wallet", "cheque", "insurance"], required: true }, reference: String, receivedBy: { type: String, default: null }, receivedAt: { type: Date, default: () => new Date() } },
    opts,
  ).index({ invoiceId: 1 }).index({ branchId: 1, receivedAt: -1 }),

  AuditEntry: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, default: null }, userId: { type: String, default: null }, action: { type: String, required: true }, entity: String, entityId: { type: String, default: null }, ip: String, data: Schema.Types.Mixed, at: { type: Date, default: () => new Date() } },
    { versionKey: false },
  ).index({ orgId: 1, at: -1 }).index({ entity: 1, entityId: 1 }),

  // ---- accounting (Tally-style)
  AccountGroup: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, name: { type: String, required: true }, parentId: { type: String, default: null }, nature: { type: String, enum: ["assets", "liabilities", "income", "expenses"], required: true }, affectsGrossProfit: { type: Boolean, default: false }, system: { type: Boolean, default: false } },
    opts,
  ).index({ orgId: 1, name: 1 }, { unique: true }),

  Ledger: new Schema(
    { _id: uuid, orgId: { type: String, required: true }, name: { type: String, required: true }, groupId: { type: String, required: true }, openingPaise: { type: Number, default: 0 }, systemKey: { type: String, default: null }, gstin: String, active: { type: Boolean, default: true } },
    opts,
  )
    .index({ orgId: 1, name: 1 }, { unique: true })
    // MongoDB counts null as a value in unique indexes, so only real keys are constrained
    .index({ orgId: 1, systemKey: 1 }, { unique: true, partialFilterExpression: { systemKey: { $type: "string" } } }),

  Voucher: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true },
      type: { type: String, enum: ["sales", "receipt", "payment", "journal", "contra", "credit_note", "debit_note", "purchase", "closing"], required: true },
      voucherNo: { type: String, required: true }, date: { type: Date, required: true }, narration: String,
      entries: { type: [new Schema({ ledgerId: { type: String, required: true }, debitPaise: { type: Number, default: 0, min: 0 }, creditPaise: { type: Number, default: 0, min: 0 }, invoiceId: { type: String, default: null } }, sub)], default: [] },
      invoiceId: { type: String, default: null }, paymentId: { type: String, default: null },
      status: { type: String, enum: ["posted", "cancelled"], default: "posted" }, createdBy: { type: String, default: null },
    },
    opts,
  ).index({ orgId: 1, voucherNo: 1 }, { unique: true }).index({ orgId: 1, date: 1 }).index({ invoiceId: 1 }),

  LedgerEntry: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, voucherId: { type: String, required: true },
      voucherType: { type: String, required: true }, voucherNo: { type: String, required: true }, ledgerId: { type: String, required: true },
      date: { type: Date, required: true }, debitPaise: { type: Number, default: 0, min: 0 }, creditPaise: { type: Number, default: 0, min: 0 },
      invoiceId: { type: String, default: null },
    },
    { versionKey: false },
  ).index({ orgId: 1, ledgerId: 1, date: 1 }).index({ orgId: 1, date: 1 }).index({ voucherId: 1 }).index({ invoiceId: 1 }),

  Counter: new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false }),

  // ---- finance (used by @mgpl-diagnostics/finance-kit)
  TaxRule: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, code: { type: String, default: null }, category: { type: String, enum: [...CATEGORIES, null], default: null },
      hsnSac: { type: String, required: true }, taxability: { type: String, enum: TAXABILITY, required: true }, ratePercent: { type: Number, default: 0, min: 0, max: 100 },
      effectiveFrom: { type: Date, required: true }, effectiveTo: { type: Date, default: null }, note: String,
    },
    opts,
  ).index({ orgId: 1, code: 1 }).index({ orgId: 1, category: 1 }),

  Customer: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, code: { type: String, required: true }, name: { type: String, required: true },
      kind: { type: String, enum: ["hospital", "insurer", "tpa", "corporate", "other"], default: "other" }, legalName: String, gstin: String, stateCode: String, pan: String,
      phone: String, email: String, address: Address, creditLimitPaise: { type: Number, default: null }, creditDays: { type: Number, default: 0, min: 0 },
      ledgerId: { type: String, required: true }, active: { type: Boolean, default: true }, lockVersion: { type: Number, default: 0 },
    },
    opts,
  ).index({ orgId: 1, code: 1 }, { unique: true }).index({ orgId: 1, name: 1 }),

  Partner: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, code: { type: String, required: true }, name: { type: String, required: true },
      kind: { type: String, enum: ["collection_centre", "franchise"], default: "collection_centre" }, branchId: { type: String, required: true }, legalName: String,
      pan: String, gstin: String, stateCode: String, phone: String, email: String, address: Address, ledgerId: { type: String, required: true },
      tds: { type: new Schema({ section: { type: String, required: true }, rateBp: { type: Number, required: true, min: 0, max: 10000 } }, sub), default: null },
      active: { type: Boolean, default: true },
    },
    opts,
  ).index({ orgId: 1, code: 1 }, { unique: true }).index({ branchId: 1 }),

  PartnerAgreement: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, partnerId: { type: String, required: true }, kind: { type: String, enum: ["revenue_share", "fixed_rate"], required: true },
      shareBp: { type: Number, default: null, min: 0, max: 10000 },
      rates: { type: [new Schema({ code: { type: String, required: true }, sharePaise: { type: Number, required: true, min: 0 } }, sub)], default: [] },
      defaultSharePaise: { type: Number, default: null }, categories: { type: [{ type: String, enum: CATEGORIES }], default: undefined },
      effectiveFrom: { type: Date, required: true }, effectiveTo: { type: Date, default: null }, notes: String,
    },
    opts,
  ).index({ partnerId: 1, effectiveFrom: 1 }),

  Settlement: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, partnerId: { type: String, required: true },
      period: { type: String, required: true }, periodKey: { type: String, default: null }, from: { type: Date, required: true }, to: { type: Date, required: true },
      lines: {
        type: [new Schema({
          invoiceId: { type: String, required: true }, invoiceNo: { type: String, required: true }, day: { type: String, required: true }, code: String, name: { type: String, required: true },
          netPaise: { type: Number, required: true }, sharePaise: { type: Number, required: true }, agreementId: { type: String, required: true }, creditNoteId: { type: String, default: null },
        }, sub)],
        default: [],
      },
      grossPaise: { type: Number, default: 0 }, sharePaise: { type: Number, default: 0 },
      deductions: { type: [new Schema({ label: { type: String, required: true }, amountPaise: { type: Number, required: true, min: 0 }, ledgerId: { type: String, default: null } }, sub)], default: [] },
      deductionsPaise: { type: Number, default: 0 }, tdsSection: { type: String, default: null }, tdsRateBp: { type: Number, default: 0 }, tdsBasePaise: { type: Number, default: 0 },
      tdsPaise: { type: Number, default: 0 }, netPaise: { type: Number, default: 0 },
      status: { type: String, enum: ["draft", "accrued", "paid", "cancelled"], default: "draft" },
      accrualVoucherId: { type: String, default: null }, payoutVoucherId: { type: String, default: null }, paidAt: { type: Date, default: null },
      createdBy: { type: String, default: null }, lockVersion: { type: Number, default: 0 },
    },
    opts,
  )
    .index({ orgId: 1, periodKey: 1 }, { unique: true, partialFilterExpression: { periodKey: { $type: "string" } } })
    .index({ partnerId: 1, period: 1 }),

  CashClosing: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, day: { type: String, required: true },
      bookPaise: { type: Number, required: true }, countedPaise: { type: Number, required: true, min: 0 }, differencePaise: { type: Number, required: true },
      denominations: { type: [new Schema({ valuePaise: { type: Number, required: true, min: 1 }, count: { type: Number, required: true, min: 0 } }, sub)], default: undefined },
      voucherId: { type: String, default: null }, closedBy: { type: String, default: null }, notes: String,
    },
    opts,
  ).index({ orgId: 1, branchId: 1, day: 1 }, { unique: true }),

  BankStatement: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, ledgerId: { type: String, required: true }, fileName: String,
      from: { type: Date, default: null }, to: { type: Date, default: null }, openingPaise: { type: Number, default: null }, closingPaise: { type: Number, default: null },
      lineCount: { type: Number, default: 0 }, importedBy: { type: String, default: null },
    },
    opts,
  ).index({ orgId: 1, ledgerId: 1 }),

  BankLine: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, statementId: { type: String, required: true }, ledgerId: { type: String, required: true },
      date: { type: Date, required: true }, description: { type: String, default: "" }, reference: String,
      debitPaise: { type: Number, default: 0, min: 0 }, creditPaise: { type: Number, default: 0, min: 0 }, balancePaise: { type: Number, default: null },
      dedupKey: { type: String, required: true }, status: { type: String, enum: ["unmatched", "matched", "ignored"], default: "unmatched" },
      matchKind: { type: String, enum: ["entry", "settlement", "manual", null], default: null }, voucherIds: { type: [String], default: [] },
      settlement: { type: new Schema({ ledgerId: { type: String, required: true }, day: { type: String, required: true }, grossPaise: { type: Number, required: true }, feePaise: { type: Number, required: true } }, sub), default: null },
      matchedBy: { type: String, default: null }, matchedAt: { type: Date, default: null },
    },
    opts,
  ).index({ orgId: 1, dedupKey: 1 }, { unique: true }).index({ statementId: 1, date: 1 }).index({ orgId: 1, ledgerId: 1, status: 1 }),

  PeriodLock: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, scope: { type: String, required: true }, branchId: { type: String, default: null },
      lockedUpTo: { type: Date, default: null }, reason: String, updatedBy: { type: String, default: null },
      /** bumped by hold() so concurrent lock changes and postings conflict inside transactions */
      lockVersion: { type: Number, default: 0 },
    },
    opts,
  ).index({ orgId: 1, scope: 1 }, { unique: true }),

  CreditNote: new Schema(
    {
      _id: uuid, orgId: { type: String, required: true }, branchId: { type: String, required: true }, invoiceId: { type: String, required: true },
      customerId: { type: String, default: null }, noteNo: { type: String, required: true }, date: { type: Date, required: true }, reason: { type: String, required: true },
      lines: {
        type: [new Schema({
          itemIndex: { type: Number, required: true, min: 0 }, name: { type: String, required: true }, code: String, hsnSac: String, taxability: { type: String, enum: TAXABILITY },
          taxPercent: { type: Number, default: 0 }, taxablePaise: { type: Number, required: true }, taxPaise: { type: Number, default: 0 },
          cgstPaise: { type: Number, default: 0 }, sgstPaise: { type: Number, default: 0 }, igstPaise: { type: Number, default: 0 },
        }, sub)],
        default: [],
      },
      taxablePaise: { type: Number, default: 0 }, taxPaise: { type: Number, default: 0 }, cgstPaise: { type: Number, default: 0 }, sgstPaise: { type: Number, default: 0 },
      igstPaise: { type: Number, default: 0 }, roundOffPaise: { type: Number, default: 0 }, totalPaise: { type: Number, required: true },
      placeOfSupply: { type: String, default: null }, buyerGstin: { type: String, default: null }, voucherId: { type: String, default: null },
      status: { type: String, enum: ["issued", "cancelled"], default: "issued" }, createdBy: { type: String, default: null },
    },
    opts,
  ).index({ orgId: 1, noteNo: 1 }, { unique: true }).index({ invoiceId: 1 }).index({ orgId: 1, date: 1 }),
};

export type ModelName = keyof typeof schemas;

/** Registers the models on a connection (idempotent). Collection names: organizations, branches, … */
export function registerModels(connection: Connection): Record<ModelName, Model<any>> {
  const out = {} as Record<ModelName, Model<any>>;
  for (const name of Object.keys(schemas) as ModelName[]) out[name] = connection.models[name] ?? connection.model(name, schemas[name]);
  return out;
}
