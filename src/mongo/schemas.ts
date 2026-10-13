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
const InvoiceItem = new Schema(
  {
    code: String,
    name: { type: String, required: true },
    category: { type: String, enum: ["test", "package", "service", "consumable", "medicine", "other"], default: "test" },
    qty: { type: Number, required: true, min: 0 },
    ratePaise: { type: Number, required: true, min: 0 },
    discountPaise: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },
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
    { _id: uuid, orgId: { type: String, required: true }, code: { type: String, required: true, uppercase: true, trim: true }, name: { type: String, required: true }, kind: { type: String, enum: ["lab", "collection_center"], default: "lab" }, phone: String, gstin: String, address: Address, active: { type: Boolean, default: true } },
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
      patientId: { type: String, required: true }, bookingId: { type: String, default: null }, items: { type: [InvoiceItem], default: [] },
      subtotalPaise: { type: Number, required: true }, discountPaise: { type: Number, default: 0 }, taxPaise: { type: Number, default: 0 },
      roundOffPaise: { type: Number, default: 0 }, totalPaise: { type: Number, required: true }, paidPaise: { type: Number, default: 0 }, duePaise: { type: Number, required: true },
      status: { type: String, enum: ["draft", "issued", "partially_paid", "paid", "cancelled", "refunded"], default: "issued" },
      issuedAt: { type: Date, default: null }, createdBy: { type: String, default: null }, cancelReason: { type: String, default: null },
      /** bumped by getForUpdate to take the document's write lock inside a transaction */
      lockVersion: { type: Number, default: 0 },
    },
    opts,
  ).index({ orgId: 1, invoiceNo: 1 }, { unique: true }).index({ patientId: 1 }).index({ branchId: 1, issuedAt: -1 }).index({ orgId: 1, status: 1 }),

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
      type: { type: String, enum: ["sales", "receipt", "payment", "journal", "contra", "credit_note", "debit_note", "purchase"], required: true },
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
};

export type ModelName = keyof typeof schemas;

/** Registers the models on a connection (idempotent). Collection names: organizations, branches, … */
export function registerModels(connection: Connection): Record<ModelName, Model<any>> {
  const out = {} as Record<ModelName, Model<any>>;
  for (const name of Object.keys(schemas) as ModelName[]) out[name] = connection.models[name] ?? connection.model(name, schemas[name]);
  return out;
}
