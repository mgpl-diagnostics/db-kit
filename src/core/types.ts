/**
 * Domain model, shared by the MongoDB and PostgreSQL backends.
 * Ids are UUID strings in both, so data and code move between backends unchanged.
 * Money is integer paise (₹1 = 100 paise), matching invoice-kit.
 */

export type Id = string;
export type Paise = number;

export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

/** Fields a caller supplies when creating an entity. */
export type New<T> = Omit<T, "id" | "createdAt" | "updatedAt"> & { id?: Id };

// ------------------------------------------------------------------ organisation

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  district?: string;
  state?: string;
  pincode?: string;
}

export interface Organization extends Timestamps {
  id: Id;
  name: string;
  legalName?: string;
  gstin?: string;
  phone?: string;
  email?: string;
  address?: Address;
  /** Prefix for patient UHIDs and invoice numbers, e.g. "MGPL". */
  code: string;
  settings: Record<string, unknown>;
}

export type BranchKind = "lab" | "collection_center";

export interface Branch extends Timestamps {
  id: Id;
  orgId: Id;
  /** Short unique code within the organisation, e.g. "RPR01". */
  code: string;
  name: string;
  kind: BranchKind;
  phone?: string;
  gstin?: string;
  address?: Address;
  active: boolean;
}

// ------------------------------------------------------------------ people & access

export type UserStatus = "active" | "disabled" | "invited";

/** A role held in one branch, or in every branch when branchId is null. */
export interface RoleAssignment {
  role: string;
  branchId: Id | null;
}

export interface User extends Timestamps {
  id: Id;
  orgId: Id;
  name: string;
  /** Lower-cased, unique within the organisation. */
  email: string;
  phone?: string;
  passwordHash: string;
  status: UserStatus;
  roles: RoleAssignment[];
  lastLoginAt?: Date | null;
}

export interface Role extends Timestamps {
  id: Id;
  orgId: Id;
  /** Unique within the organisation, e.g. "pathologist". */
  key: string;
  name: string;
  permissions: string[];
  /** Built-in roles cannot be deleted. */
  system: boolean;
}

export interface AuditEntry {
  id: Id;
  orgId: Id;
  branchId?: Id | null;
  userId?: Id | null;
  /** e.g. "invoice.issue", "report.verify", "auth.login" */
  action: string;
  entity?: string;
  entityId?: Id | null;
  ip?: string;
  data?: Record<string, unknown>;
  at: Date;
}

export type Sex = "male" | "female" | "other";

export interface Patient extends Timestamps {
  id: Id;
  orgId: Id;
  /** Branch where the patient registered. */
  branchId: Id;
  /** Unique hospital id within the organisation, e.g. "MGPL-000123". */
  uhid: string;
  title?: string;
  name: string;
  sex: Sex;
  dob?: Date | null;
  /** When the date of birth is unknown. */
  ageYears?: number | null;
  phone?: string;
  email?: string;
  address?: Address;
}

export interface Doctor extends Timestamps {
  id: Id;
  orgId: Id;
  name: string;
  qualification?: string;
  phone?: string;
  clinic?: string;
  active: boolean;
}

// ------------------------------------------------------------------ work

export type BookingStatus = "booked" | "sample_collected" | "in_process" | "completed" | "cancelled";
export type CollectionType = "walk_in" | "home";

export interface BookingTest {
  /** Test id or code in @mgpl-diagnostics/catalog-kit. */
  testCode: string;
  name: string;
  pricePaise: Paise;
  sampleType?: string;
}

export interface Booking extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  bookingNo: string;
  patientId: Id;
  doctorId?: Id | null;
  tests: BookingTest[];
  sampleCollection: { type: CollectionType; scheduledAt?: Date | null; address?: Address };
  status: BookingStatus;
  invoiceId?: Id | null;
  createdBy?: Id | null;
  notes?: string;
}

export type SampleStatus = "pending" | "collected" | "received" | "rejected";

export interface Sample extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  bookingId: Id;
  /** Unique within the organisation (printed as the tube barcode). */
  barcode: string;
  sampleType: string;
  status: SampleStatus;
  collectedAt?: Date | null;
  collectedBy?: Id | null;
  receivedAt?: Date | null;
  rejectReason?: string | null;
}

export type ReportStatus = "draft" | "entered" | "verified" | "released" | "amended";

export interface ResultValue {
  parameter: string;
  value: string;
  unit?: string;
  flag?: "L" | "H" | "A" | "";
  range?: string;
}

export interface Report extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  bookingId: Id;
  patientId: Id;
  testCode: string;
  testName: string;
  results: ResultValue[];
  status: ReportStatus;
  enteredBy?: Id | null;
  verifiedBy?: Id | null;
  verifiedAt?: Date | null;
  releasedAt?: Date | null;
  /** Increases on every amendment after release. */
  version: number;
}

// ------------------------------------------------------------------ billing

export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "cancelled" | "refunded";
export type ItemCategory = "test" | "package" | "service" | "consumable" | "medicine" | "other";

export interface InvoiceItem {
  code?: string;
  name: string;
  category: ItemCategory;
  qty: number;
  ratePaise: Paise;
  discountPaise: Paise;
  /** GST percent, 0–100. */
  taxPercent: number;
  /** qty × rate − discount, before tax. */
  amountPaise: Paise;
}

export interface InvoiceTotals {
  subtotalPaise: Paise;
  discountPaise: Paise;
  taxPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
}

export interface Invoice extends Timestamps, InvoiceTotals {
  id: Id;
  orgId: Id;
  branchId: Id;
  /** Unique within the organisation, e.g. "MGPL/RPR01/2026-27/000123". */
  invoiceNo: string;
  patientId: Id;
  bookingId?: Id | null;
  items: InvoiceItem[];
  paidPaise: Paise;
  duePaise: Paise;
  status: InvoiceStatus;
  issuedAt?: Date | null;
  createdBy?: Id | null;
  cancelReason?: string | null;
}

export type PaymentMode = "cash" | "upi" | "card" | "netbanking" | "wallet" | "cheque" | "insurance";

export interface Payment extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  invoiceId: Id;
  kind: "payment" | "refund";
  /** Always positive; refunds subtract. */
  amountPaise: Paise;
  mode: PaymentMode;
  reference?: string;
  receivedBy?: Id | null;
  receivedAt: Date;
}

// ------------------------------------------------------------------ accounting (Tally-style double entry)

/** Where a group sits in the books. Assets/liabilities → balance sheet; income/expenses → P&L. */
export type AccountNature = "assets" | "liabilities" | "income" | "expenses";

/** Tally's account groups (Capital Account, Current Assets, Sundry Debtors, Sales Accounts…). */
export interface AccountGroup extends Timestamps {
  id: Id;
  orgId: Id;
  name: string;
  /** null for primary groups. */
  parentId: Id | null;
  nature: AccountNature;
  /** Direct incomes/expenses, sales and purchases: they make up gross profit. */
  affectsGrossProfit: boolean;
  system: boolean;
}

export interface Ledger extends Timestamps {
  id: Id;
  orgId: Id;
  name: string;
  groupId: Id;
  /** Opening balance in paise: positive = Debit, negative = Credit. */
  openingPaise: Paise;
  /**
   * Fixed role used by automatic posting: "cash", "bank", "upi", "card", "receivables", "sales",
   * "discount", "round_off", "cgst", "sgst", "igst", "doctor_commission", "doctors_payable".
   */
  systemKey?: string | null;
  gstin?: string;
  active: boolean;
}

export type VoucherType = "sales" | "receipt" | "payment" | "journal" | "contra" | "credit_note" | "debit_note" | "purchase";

/** One line of a voucher. Exactly one of debit / credit is positive. */
export interface VoucherEntry {
  ledgerId: Id;
  debitPaise: Paise;
  creditPaise: Paise;
  /** Bill-wise tracking (Tally "Agst Ref"): which invoice this line settles or raises. */
  invoiceId?: Id | null;
}

export interface Voucher extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  type: VoucherType;
  /** "SAL/2026-27/000045" — one series per type per financial year. */
  voucherNo: string;
  date: Date;
  narration?: string;
  entries: VoucherEntry[];
  invoiceId?: Id | null;
  paymentId?: Id | null;
  status: "posted" | "cancelled";
  createdBy?: Id | null;
}

/** A posting: one voucher line, stored flat so balances and statements are simple sums. */
export interface LedgerEntry {
  id: Id;
  orgId: Id;
  branchId: Id;
  voucherId: Id;
  voucherType: VoucherType;
  voucherNo: string;
  ledgerId: Id;
  date: Date;
  debitPaise: Paise;
  creditPaise: Paise;
  invoiceId?: Id | null;
}
