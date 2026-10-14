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
  /** GST state code where the branch supplies from, e.g. "22" (Chhattisgarh). Falls back to the GSTIN's first two digits. */
  stateCode?: string;
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

/** "credited": credit notes cover the whole invoice. */
export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "cancelled" | "refunded" | "credited";
export type ItemCategory = "test" | "package" | "service" | "consumable" | "medicine" | "other";
/** How GST treats a line. Rates and exemptions are configuration (finance-kit tax rules), checked by the lab's CA. */
export type Taxability = "taxable" | "exempt" | "nil_rated" | "non_gst";

export interface InvoiceItem {
  code?: string;
  name: string;
  category: ItemCategory;
  qty: number;
  ratePaise: Paise;
  discountPaise: Paise;
  /** GST percent, 0–100. */
  taxPercent: number;
  /** SAC (services) or HSN (goods) code, for GST returns. */
  hsnSac?: string;
  taxability?: Taxability;
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
  /** B2B customer billed (hospital, insurer/TPA, corporate); null for patient bills. */
  customerId?: Id | null;
  /** GST state code of the place of supply, e.g. "22". */
  placeOfSupply?: string | null;
  /** Buyer's GSTIN at the time of the invoice (B2B in GSTR-1). */
  buyerGstin?: string | null;
  items: InvoiceItem[];
  paidPaise: Paise;
  /** Sum of credit notes against this invoice (total incl. tax). */
  creditedPaise: Paise;
  /** total − credited − paid, never below 0. */
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

/** "closing" = the year-end voucher that moves the P&L result to Reserves & Surplus (left out of profitAndLoss). */
export type VoucherType = "sales" | "receipt" | "payment" | "journal" | "contra" | "credit_note" | "debit_note" | "purchase" | "closing";

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

// ------------------------------------------------------------------ finance (storage for @mgpl-diagnostics/finance-kit)
// Dates nested inside arrays are IST day strings ("2026-10-14"): JSONB would return them as strings anyway.

/** A GST rule: which SAC/HSN, taxability and rate apply to an item code or a whole category from a date. */
export interface TaxRule extends Timestamps {
  id: Id;
  orgId: Id;
  /** Item code; null = the whole category. A code rule wins over a category rule. */
  code?: string | null;
  category?: ItemCategory | null;
  /** SAC (services) or HSN (goods). */
  hsnSac: string;
  taxability: Taxability;
  /** GST percent, 0–100 (0 unless taxable). */
  ratePercent: number;
  effectiveFrom: Date;
  /** Inclusive; null = open-ended. */
  effectiveTo?: Date | null;
  note?: string;
}

export type CustomerKind = "hospital" | "insurer" | "tpa" | "corporate" | "other";

/** A B2B customer billed on credit. */
export interface Customer extends Timestamps {
  id: Id;
  orgId: Id;
  /** Unique within the organisation, e.g. "CITYHOSP". */
  code: string;
  name: string;
  kind: CustomerKind;
  legalName?: string;
  gstin?: string;
  /** GST state code, e.g. "22". Falls back to the GSTIN's first two digits. */
  stateCode?: string;
  pan?: string;
  phone?: string;
  email?: string;
  address?: Address;
  /** null = no limit. */
  creditLimitPaise: Paise | null;
  /** Payment terms in days from the invoice date. */
  creditDays: number;
  /** The customer's own ledger under Sundry Debtors. */
  ledgerId: Id;
  active: boolean;
}

export type PartnerKind = "collection_centre" | "franchise";

/** A business partner (collection centre or franchise) paid a share of what its tests bill. */
export interface Partner extends Timestamps {
  id: Id;
  orgId: Id;
  /** Unique within the organisation. */
  code: string;
  name: string;
  kind: PartnerKind;
  /** The branch (usually a collection_center) whose invoices count for this partner. */
  branchId: Id;
  legalName?: string;
  pan?: string;
  gstin?: string;
  stateCode?: string;
  phone?: string;
  email?: string;
  address?: Address;
  /** The partner's payable ledger under Sundry Creditors. */
  ledgerId: Id;
  /** Overrides the default TDS (e.g. a lower-deduction certificate). Rate in basis points. */
  tds?: { section: string; rateBp: number } | null;
  active: boolean;
}

export type AgreementKind = "revenue_share" | "fixed_rate";

/** What a partner earns, effective from a date. */
export interface PartnerAgreement extends Timestamps {
  id: Id;
  orgId: Id;
  partnerId: Id;
  kind: AgreementKind;
  /** revenue_share: share of the net billed value (after discounts, before GST) in basis points (2500 = 25%). */
  shareBp?: number | null;
  /** fixed_rate: amount per unit, by item code. */
  rates?: { code: string; sharePaise: Paise }[];
  /** fixed_rate: amount for codes not in `rates` (default 0). */
  defaultSharePaise?: Paise | null;
  /** Item categories that earn a share. Default: test, package. */
  categories?: ItemCategory[];
  effectiveFrom: Date;
  /** Inclusive; null = open-ended. */
  effectiveTo?: Date | null;
  notes?: string;
}

export interface SettlementLine {
  invoiceId: Id;
  invoiceNo: string;
  /** IST day of the invoice or credit note, "2026-10-03". */
  day: string;
  code?: string;
  name: string;
  /** Net billed value of the line (negative for a credit note). */
  netPaise: Paise;
  sharePaise: Paise;
  agreementId: Id;
  creditNoteId?: Id | null;
}

export interface SettlementDeduction {
  label: string;
  amountPaise: Paise;
  /** Ledger credited; default: the "partner_recoveries" ledger. */
  ledgerId?: Id | null;
}

export type SettlementStatus = "draft" | "accrued" | "paid" | "cancelled";

/** A partner's statement for one month. */
export interface Settlement extends Timestamps {
  id: Id;
  orgId: Id;
  /** Branch whose books carry the vouchers. */
  branchId: Id;
  partnerId: Id;
  /** "2026-10" */
  period: string;
  /** "<partnerId>:<period>" while not cancelled (unique); null once cancelled. */
  periodKey?: string | null;
  from: Date;
  to: Date;
  lines: SettlementLine[];
  grossPaise: Paise;
  sharePaise: Paise;
  deductions: SettlementDeduction[];
  deductionsPaise: Paise;
  tdsSection?: string | null;
  tdsRateBp: number;
  /** Amount TDS was computed on (share, plus earlier shares of the year when the threshold is crossed). */
  tdsBasePaise: Paise;
  tdsPaise: Paise;
  /** share − deductions − TDS */
  netPaise: Paise;
  status: SettlementStatus;
  accrualVoucherId?: Id | null;
  payoutVoucherId?: Id | null;
  paidAt?: Date | null;
  createdBy?: Id | null;
}

export interface CashDenomination {
  valuePaise: Paise;
  count: number;
}

/** A branch's day-end cash count. One per branch per day. */
export interface CashClosing extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  /** IST day, "2026-10-14". */
  day: string;
  bookPaise: Paise;
  countedPaise: Paise;
  /** counted − book: negative = short, positive = excess. */
  differencePaise: Paise;
  denominations?: CashDenomination[];
  voucherId?: Id | null;
  closedBy?: Id | null;
  notes?: string;
}

export interface BankStatement extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  /** The bank ledger this statement belongs to. */
  ledgerId: Id;
  fileName?: string;
  from?: Date | null;
  to?: Date | null;
  openingPaise?: Paise | null;
  closingPaise?: Paise | null;
  lineCount: number;
  importedBy?: Id | null;
}

export type BankLineStatus = "unmatched" | "matched" | "ignored";

export interface BankLine extends Timestamps {
  id: Id;
  orgId: Id;
  statementId: Id;
  ledgerId: Id;
  date: Date;
  description: string;
  reference?: string;
  /** Money out of the account. */
  debitPaise: Paise;
  /** Money into the account. */
  creditPaise: Paise;
  balancePaise?: Paise | null;
  /** Unique per organisation, so importing the same statement twice adds nothing. */
  dedupKey: string;
  status: BankLineStatus;
  matchKind?: "entry" | "settlement" | "manual" | null;
  /** Vouchers this line is matched with (their postings on the bank ledger). */
  voucherIds: Id[];
  /** Card / UPI settlement: the clearing ledger and IST day it settles. */
  settlement?: { ledgerId: Id; day: string; grossPaise: Paise; feePaise: Paise } | null;
  matchedBy?: Id | null;
  matchedAt?: Date | null;
}

/** Lock date for the whole organisation (scope "org") or one branch (scope = branch id). */
export interface PeriodLock extends Timestamps {
  id: Id;
  orgId: Id;
  /** "org" or a branch id. Unique per organisation. */
  scope: string;
  branchId: Id | null;
  /** No voucher dated on or before this instant may be posted or cancelled. null = nothing locked. */
  lockedUpTo: Date | null;
  reason?: string;
  updatedBy?: Id | null;
}

export interface CreditNoteLine {
  /** Index of the invoice item credited. */
  itemIndex: number;
  name: string;
  code?: string;
  hsnSac?: string;
  taxability?: Taxability;
  taxPercent: number;
  taxablePaise: Paise;
  taxPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
}

/** A GST credit note against an invoice (refund or price correction). */
export interface CreditNote extends Timestamps {
  id: Id;
  orgId: Id;
  branchId: Id;
  invoiceId: Id;
  customerId?: Id | null;
  /** Unique within the organisation. */
  noteNo: string;
  date: Date;
  reason: string;
  lines: CreditNoteLine[];
  taxablePaise: Paise;
  taxPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
  placeOfSupply?: string | null;
  buyerGstin?: string | null;
  voucherId?: Id | null;
  status: "issued" | "cancelled";
  createdBy?: Id | null;
}
