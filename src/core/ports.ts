import type {
  AccountGroup, AuditEntry, BankLine, BankStatement, Booking, Branch, CashClosing, CreditNote, Customer, Doctor, Id, Invoice, Ledger,
  LedgerEntry, New, Organization, Partner, PartnerAgreement, Patient, Payment, PeriodLock, Report, Role, Sample, Settlement, TaxRule, User,
  Voucher, VoucherType,
} from "./types";

/** Equality filter on top-level fields. Portable across both backends. */
export type Filter<T> = { [K in keyof T]?: T[K] };

export interface ListOptions<T> {
  limit?: number;
  offset?: number;
  sort?: { field: keyof T & string; dir?: "asc" | "desc" };
}

export interface Repo<T extends { id: Id }> {
  create(data: New<T>): Promise<T>;
  get(id: Id): Promise<T | null>;
  /** Several by id, in any order (missing ids are skipped). Used by DataLoader. */
  getMany(ids: readonly Id[]): Promise<T[]>;
  /** Returns the updated entity, or null when it does not exist. */
  update(id: Id, patch: Partial<New<T>>): Promise<T | null>;
  delete(id: Id): Promise<boolean>;
  find(filter?: Filter<T>, options?: ListOptions<T>): Promise<T[]>;
  findOne(filter: Filter<T>): Promise<T | null>;
  count(filter?: Filter<T>): Promise<number>;
}

export interface UserRepo extends Repo<User> {
  findByEmail(orgId: Id, email: string): Promise<User | null>;
  /** Same email in several organisations is allowed; login then needs the organisation. */
  findAllByEmail(email: string): Promise<User[]>;
}

export interface PatientRepo extends Repo<Patient> {
  /** Case-insensitive match on name, phone or UHID. */
  search(orgId: Id, query: string, limit?: number): Promise<Patient[]>;
}

/** A repository whose rows can be locked inside a transaction. */
export interface LockableRepo<T extends { id: Id }> extends Repo<T> {
  /** Inside a transaction: read and lock the row/document until commit. */
  getForUpdate(id: Id): Promise<T | null>;
}

/** Filter for documents by date. `from` and `to` are inclusive. */
export interface DateQuery {
  orgId: Id;
  branchId?: Id;
  from?: Date;
  to?: Date;
}

export interface InvoiceRepo extends LockableRepo<Invoice> {
  /** Issued / partly paid invoices with an amount due, oldest first. */
  listOutstanding(orgId: Id, branchId?: Id): Promise<Invoice[]>;
  /** By issue date, oldest first (then invoice number). Drafts are left out; cancelled ones only on request. */
  listByDate(query: DateQuery & { customerId?: Id; includeCancelled?: boolean }): Promise<Invoice[]>;
}

export interface AuditRepo {
  log(entry: Omit<AuditEntry, "id" | "at"> & { at?: Date }): Promise<AuditEntry>;
  find(filter?: Filter<AuditEntry>, options?: ListOptions<AuditEntry>): Promise<AuditEntry[]>;
}

export interface CounterRepo {
  /** Atomically increments and returns the next value (1, 2, 3…) for a key. */
  next(key: string): Promise<number>;
  /** Current value without incrementing (0 when unused). */
  peek(key: string): Promise<number>;
}

export interface VoucherQuery {
  orgId: Id;
  branchId?: Id;
  type?: Voucher["type"];
  /** inclusive */
  from?: Date;
  /** inclusive */
  to?: Date;
  includeCancelled?: boolean;
}

export interface VoucherRepo extends Repo<Voucher> {
  /** By date, oldest first (the day book). */
  listByDate(query: VoucherQuery, options?: { limit?: number; offset?: number }): Promise<Voucher[]>;
}

export interface LedgerRepo extends Repo<Ledger> {
  findBySystemKey(orgId: Id, key: string): Promise<Ledger | null>;
}

/** Filter for postings. `from` and `to` are inclusive. */
export interface EntryQuery {
  orgId: Id;
  branchId?: Id;
  ledgerId?: Id;
  invoiceId?: Id;
  from?: Date;
  to?: Date;
  /** Leave out postings of these voucher types (e.g. "closing" for a P&L). */
  excludeVoucherTypes?: VoucherType[];
}

export interface LedgerTotals {
  ledgerId: Id;
  debitPaise: number;
  creditPaise: number;
}

export interface LedgerEntryRepo {
  insertMany(entries: Omit<LedgerEntry, "id">[]): Promise<void>;
  deleteByVoucher(voucherId: Id): Promise<number>;
  /** Oldest first (date, then voucher number). */
  list(query: EntryQuery, options?: { limit?: number; offset?: number }): Promise<LedgerEntry[]>;
  /** Debit and credit sums per ledger. */
  totals(query: EntryQuery): Promise<LedgerTotals[]>;
}

export interface CreditNoteRepo extends Repo<CreditNote> {
  /** By date, oldest first (then note number). Cancelled notes only on request. */
  listByDate(query: DateQuery & { includeCancelled?: boolean }): Promise<CreditNote[]>;
}

export type HoldMode = "share" | "update";

export interface PeriodLockRepo extends Repo<PeriodLock> {
  /**
   * Inside a transaction: reads the lock rows of these scopes ("org" and/or branch ids), creating
   * empty ones, and holds them until commit. "share" (posting) lets other postings through but makes a
   * concurrent lock change wait for this transaction (PostgreSQL) or conflict and retry (MongoDB);
   * "update" (changing a lock) is exclusive.
   */
  hold(orgId: Id, scopes: string[], mode: HoldMode): Promise<PeriodLock[]>;
}

/**
 * Called by the billing workflows, inside their transaction, to post the books. The default posts
 * with this package's accounting; an accounting kit (finance-kit today, tally-kit later) supplies its own.
 */
export interface PostingHook {
  invoiceIssued(tx: Repositories, invoice: Invoice, actorId?: string): Promise<void>;
  paymentRecorded(tx: Repositories, payment: Payment, invoiceNo: string, actorId?: string): Promise<void>;
  invoiceCancelled(tx: Repositories, invoiceId: string, actorId?: string): Promise<void>;
}

export type Backend = "mongo" | "pg";

export interface Repositories {
  readonly backend: Backend;
  orgs: Repo<Organization>;
  branches: Repo<Branch>;
  users: UserRepo;
  roles: Repo<Role>;
  patients: PatientRepo;
  doctors: Repo<Doctor>;
  bookings: Repo<Booking>;
  samples: Repo<Sample>;
  reports: Repo<Report>;
  invoices: InvoiceRepo;
  payments: Repo<Payment>;
  audit: AuditRepo;
  counters: CounterRepo;
  // accounting
  accountGroups: Repo<AccountGroup>;
  ledgers: LedgerRepo;
  vouchers: VoucherRepo;
  ledgerEntries: LedgerEntryRepo;
  // finance (used by @mgpl-diagnostics/finance-kit)
  taxRules: Repo<TaxRule>;
  customers: LockableRepo<Customer>;
  partners: Repo<Partner>;
  partnerAgreements: Repo<PartnerAgreement>;
  settlements: LockableRepo<Settlement>;
  cashClosings: Repo<CashClosing>;
  bankStatements: Repo<BankStatement>;
  bankLines: Repo<BankLine>;
  periodLocks: PeriodLockRepo;
  creditNotes: CreditNoteRepo;
  /** Posting for invoices and payments; the default (this package's accounting) when unset. */
  readonly posting?: PostingHook;
  /**
   * Runs `fn` atomically. Use the `tx` repositories inside it. MongoDB needs a replica set for
   * transactions; on a standalone server the work runs without one.
   */
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
  /** Creates collections / tables and indexes (idempotent). */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** A voucher dated on or before a lock date was posted, cancelled or changed. */
export class PeriodLockedError extends ConflictError {
  constructor(date: Date, lockedUpTo: Date, scope: string) {
    super(`Books are locked up to ${lockedUpTo.toISOString()} (${scope === "org" ? "organisation" : `branch ${scope}`}); ${date.toISOString()} is in a locked period`);
    this.name = "PeriodLockedError";
  }
}

/** Invalid input (bad amount, empty booking, unbalanced lines…). */
export class ValidationError extends Error {
  readonly statusCode: number = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
