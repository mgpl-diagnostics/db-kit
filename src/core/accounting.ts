import { financialYear } from "./numbering";
import { NotFoundError, PeriodLockedError, ValidationError, type PostingHook, type Repositories } from "./ports";
import type {
  AccountGroup, AccountNature, Id, Invoice, Ledger, Payment, PaymentMode, Voucher, VoucherEntry, VoucherType,
} from "./types";

/**
 * Tally-style double-entry books.
 *
 * Groups → ledgers → vouchers. Every voucher's debits equal its credits; each line is also stored
 * as a LedgerEntry, so any balance is a sum. Invoices and payments post vouchers automatically:
 *
 *   Sales voucher (invoice)       Dr Patient Receivables  total
 *                                 Dr Discount Allowed     discount
 *                                 Cr Lab Test Income      gross (qty × rate)
 *                                 Cr Output CGST / SGST   tax  (IGST when inter-state)
 *                                 Dr/Cr Round Off         rounding
 *   Receipt voucher (payment)     Dr Cash / Bank / UPI / Card    Cr Patient Receivables
 *   Payment voucher (refund)      Dr Patient Receivables         Cr Cash / Bank / UPI / Card
 */

// ------------------------------------------------------------------ chart of accounts

interface GroupDef {
  name: string;
  parent?: string;
  nature?: AccountNature;
  gp?: boolean;
}

/** Tally's 28 predefined groups: 15 primary + 13 sub-groups. */
export const TALLY_GROUPS: GroupDef[] = [
  { name: "Capital Account", nature: "liabilities" },
  { name: "Loans (Liability)", nature: "liabilities" },
  { name: "Current Liabilities", nature: "liabilities" },
  { name: "Fixed Assets", nature: "assets" },
  { name: "Investments", nature: "assets" },
  { name: "Current Assets", nature: "assets" },
  { name: "Branch / Divisions", nature: "liabilities" },
  { name: "Misc. Expenses (ASSET)", nature: "assets" },
  { name: "Suspense A/c", nature: "liabilities" },
  { name: "Sales Accounts", nature: "income", gp: true },
  { name: "Purchase Accounts", nature: "expenses", gp: true },
  { name: "Direct Incomes", nature: "income", gp: true },
  { name: "Indirect Incomes", nature: "income" },
  { name: "Direct Expenses", nature: "expenses", gp: true },
  { name: "Indirect Expenses", nature: "expenses" },
  { name: "Reserves & Surplus", parent: "Capital Account" },
  { name: "Bank OD A/c", parent: "Loans (Liability)" },
  { name: "Secured Loans", parent: "Loans (Liability)" },
  { name: "Unsecured Loans", parent: "Loans (Liability)" },
  { name: "Duties & Taxes", parent: "Current Liabilities" },
  { name: "Provisions", parent: "Current Liabilities" },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Bank Accounts", parent: "Current Assets" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Deposits (Asset)", parent: "Current Assets" },
  { name: "Loans & Advances (Asset)", parent: "Current Assets" },
  { name: "Stock-in-Hand", parent: "Current Assets" },
  { name: "Sundry Debtors", parent: "Current Assets" },
];

/** Ledgers a diagnostic lab needs on day one. `key` = systemKey used by automatic posting. */
export const DEFAULT_LEDGERS: { name: string; group: string; key?: string }[] = [
  { name: "Capital Account", group: "Capital Account", key: "capital" },
  { name: "Cash", group: "Cash-in-Hand", key: "cash" },
  { name: "Bank Account", group: "Bank Accounts", key: "bank" },
  { name: "UPI Collections", group: "Bank Accounts", key: "upi" },
  { name: "Card Settlements", group: "Bank Accounts", key: "card" },
  { name: "Patient Receivables", group: "Sundry Debtors", key: "receivables" },
  { name: "Lab Test Income", group: "Sales Accounts", key: "sales" },
  { name: "Output CGST", group: "Duties & Taxes", key: "cgst" },
  { name: "Output SGST", group: "Duties & Taxes", key: "sgst" },
  { name: "Output IGST", group: "Duties & Taxes", key: "igst" },
  { name: "Discount Allowed", group: "Indirect Expenses", key: "discount" },
  { name: "Round Off", group: "Indirect Expenses", key: "round_off" },
  { name: "Doctor Referral Commission", group: "Indirect Expenses", key: "doctor_commission" },
  { name: "Doctors Payable", group: "Sundry Creditors", key: "doctors_payable" },
  { name: "Reagents & Consumables", group: "Purchase Accounts", key: "purchases" },
  { name: "Salaries", group: "Indirect Expenses" },
  { name: "Rent", group: "Indirect Expenses" },
  { name: "Electricity", group: "Indirect Expenses" },
  { name: "Lab Equipment", group: "Fixed Assets" },
];

/** Creates the groups and default ledgers for an organisation (skips ones that exist). */
export async function seedChartOfAccounts(repos: Repositories, orgId: Id): Promise<{ groups: AccountGroup[]; ledgers: Ledger[] }> {
  return repos.transaction(async (tx) => {
    const byName = new Map<string, AccountGroup>();
    for (const g of await tx.accountGroups.find({ orgId })) byName.set(g.name, g);
    for (const def of TALLY_GROUPS) {
      if (byName.has(def.name)) continue;
      const parent = def.parent ? byName.get(def.parent)! : null;
      const g = await tx.accountGroups.create({
        orgId, name: def.name, parentId: parent?.id ?? null,
        nature: def.nature ?? parent!.nature, affectsGrossProfit: def.gp ?? parent?.affectsGrossProfit ?? false, system: true,
      });
      byName.set(g.name, g);
    }
    const existing = new Set((await tx.ledgers.find({ orgId })).map((l) => l.name));
    for (const l of DEFAULT_LEDGERS) {
      if (existing.has(l.name)) continue;
      await tx.ledgers.create({ orgId, name: l.name, groupId: byName.get(l.group)!.id, openingPaise: 0, systemKey: l.key ?? null, active: true });
    }
    return { groups: [...byName.values()], ledgers: await tx.ledgers.find({ orgId }) };
  });
}

// ------------------------------------------------------------------ vouchers

export const VOUCHER_PREFIX: Record<VoucherType, string> = {
  sales: "SAL", receipt: "RCT", payment: "PMT", journal: "JRN", contra: "CTR", credit_note: "CRN", debit_note: "DBN", purchase: "PUR", closing: "CLS",
};

export const voucherCounterKey = (orgId: Id, type: VoucherType, fy: string) => `voucher:${orgId}:${type}:${fy}`;

export interface VoucherInput {
  orgId: Id;
  branchId: Id;
  type: VoucherType;
  date?: Date;
  narration?: string;
  entries: VoucherEntry[];
  invoiceId?: Id | null;
  paymentId?: Id | null;
}

export class UnbalancedVoucherError extends ValidationError {
  readonly statusCode = 422;
  constructor(debit: number, credit: number) {
    super(`Voucher does not balance: debit ${debit} ≠ credit ${credit} paise`);
    this.name = "UnbalancedVoucherError";
  }
}

/** Throws unless every line is one-sided whole paise and debits equal credits. */
export function assertBalanced(entries: VoucherEntry[]): void {
  if (entries.length < 2) throw new UnbalancedVoucherError(0, 0);
  let dr = 0;
  let cr = 0;
  for (const e of entries) {
    const okDr = Number.isInteger(e.debitPaise) && e.debitPaise >= 0;
    const okCr = Number.isInteger(e.creditPaise) && e.creditPaise >= 0;
    if (!okDr || !okCr || (e.debitPaise > 0) === (e.creditPaise > 0)) throw new ValidationError("Each voucher line needs exactly one positive debit or credit (whole paise)");
    dr += e.debitPaise;
    cr += e.creditPaise;
  }
  if (dr !== cr) throw new UnbalancedVoucherError(dr, cr);
}

// ------------------------------------------------------------------ lock dates

/**
 * Inside a transaction: throws PeriodLockedError when `date` is on or before the organisation's or
 * the branch's lock date. Holds both lock rows until commit, so a concurrent lock change cannot slip
 * in between this check and the commit. postVoucher and cancelVoucher call it.
 */
export async function assertPeriodOpen(tx: Repositories, orgId: Id, branchId: Id, date: Date): Promise<void> {
  for (const lock of await tx.periodLocks.hold(orgId, ["org", branchId], "share"))
    if (lock.lockedUpTo && date.getTime() <= lock.lockedUpTo.getTime()) throw new PeriodLockedError(date, lock.lockedUpTo, lock.scope);
}

/** Numbers, stores and posts a voucher atomically (voucher + its ledger entries). Refused in a locked period. */
export async function postVoucher(repos: Repositories, input: VoucherInput, actorId?: Id): Promise<Voucher> {
  const entries = input.entries.filter((e) => e.debitPaise > 0 || e.creditPaise > 0);
  assertBalanced(entries);
  const date = input.date ?? new Date();
  return repos.transaction(async (tx) => {
    await assertPeriodOpen(tx, input.orgId, input.branchId, date);
    const ids = [...new Set(entries.map((e) => e.ledgerId))];
    for (const id of ids) if (!(await tx.ledgers.get(id))) throw new NotFoundError("Ledger", id);
    const fy = financialYear(date);
    const seq = await tx.counters.next(voucherCounterKey(input.orgId, input.type, fy));
    const voucher = await tx.vouchers.create({
      orgId: input.orgId, branchId: input.branchId, type: input.type, voucherNo: `${VOUCHER_PREFIX[input.type]}/${fy}/${String(seq).padStart(6, "0")}`,
      date, narration: input.narration, entries, invoiceId: input.invoiceId ?? null, paymentId: input.paymentId ?? null, status: "posted", createdBy: actorId ?? null,
    });
    await tx.ledgerEntries.insertMany(entries.map((e) => ({
      orgId: input.orgId, branchId: input.branchId, voucherId: voucher.id, voucherType: input.type, voucherNo: voucher.voucherNo,
      ledgerId: e.ledgerId, date, debitPaise: e.debitPaise, creditPaise: e.creditPaise, invoiceId: e.invoiceId ?? null,
    })));
    await tx.audit.log({ orgId: input.orgId, branchId: input.branchId, userId: actorId ?? null, action: `voucher.${input.type}`, entity: "voucher", entityId: voucher.id, data: { voucherNo: voucher.voucherNo } });
    return voucher;
  });
}

/** Cancels a voucher the Tally way: the number stays, the postings are removed. Refused in a locked period. */
export async function cancelVoucher(repos: Repositories, voucherId: Id, actorId?: Id): Promise<Voucher> {
  return repos.transaction(async (tx) => {
    const v = await tx.vouchers.get(voucherId);
    if (!v) throw new NotFoundError("Voucher", voucherId);
    if (v.status === "cancelled") return v;
    await assertPeriodOpen(tx, v.orgId, v.branchId, v.date);
    await tx.ledgerEntries.deleteByVoucher(voucherId);
    const out = (await tx.vouchers.update(voucherId, { status: "cancelled" }))!;
    await tx.audit.log({ orgId: v.orgId, branchId: v.branchId, userId: actorId ?? null, action: "voucher.cancel", entity: "voucher", entityId: voucherId });
    return out;
  });
}

// ------------------------------------------------------------------ automatic posting

const MODE_LEDGER: Record<PaymentMode, string> = {
  cash: "cash", upi: "upi", wallet: "upi", card: "card", netbanking: "bank", cheque: "bank", insurance: "bank",
};

/** Ledgers by systemKey, or null when the organisation has no chart of accounts (posting is skipped). */
async function systemLedgers(repos: Repositories, orgId: Id): Promise<Map<string, Ledger> | null> {
  const all = await repos.ledgers.find({ orgId });
  const map = new Map<string, Ledger>();
  for (const l of all) if (l.systemKey) map.set(l.systemKey, l);
  return map.has("receivables") && map.has("sales") ? map : null;
}

const need = (m: Map<string, Ledger>, key: string) => {
  const l = m.get(key);
  if (!l) throw new NotFoundError("Ledger with systemKey", key);
  return l.id;
};

export function salesEntries(invoice: Invoice, ledgers: Map<string, Ledger>, interState = false): VoucherEntry[] {
  const gross = invoice.items.reduce((s, i) => s + i.amountPaise + i.discountPaise, 0);
  const tax = invoice.taxPaise;
  const cgst = Math.floor(tax / 2);
  const r = invoice.roundOffPaise;
  const e: VoucherEntry[] = [
    { ledgerId: need(ledgers, "receivables"), debitPaise: invoice.totalPaise, creditPaise: 0, invoiceId: invoice.id },
    { ledgerId: need(ledgers, "discount"), debitPaise: invoice.discountPaise, creditPaise: 0 },
    { ledgerId: need(ledgers, "sales"), debitPaise: 0, creditPaise: gross },
  ];
  if (tax > 0) {
    if (interState) e.push({ ledgerId: need(ledgers, "igst"), debitPaise: 0, creditPaise: tax });
    else e.push({ ledgerId: need(ledgers, "cgst"), debitPaise: 0, creditPaise: cgst }, { ledgerId: need(ledgers, "sgst"), debitPaise: 0, creditPaise: tax - cgst });
  }
  if (r !== 0) e.push({ ledgerId: need(ledgers, "round_off"), debitPaise: r < 0 ? -r : 0, creditPaise: r > 0 ? r : 0 });
  return e.filter((x) => x.debitPaise > 0 || x.creditPaise > 0);
}

export function receiptEntries(payment: Payment, ledgers: Map<string, Ledger>): VoucherEntry[] {
  const money = need(ledgers, MODE_LEDGER[payment.mode]);
  const recv = need(ledgers, "receivables");
  return payment.kind === "refund"
    ? [{ ledgerId: recv, debitPaise: payment.amountPaise, creditPaise: 0, invoiceId: payment.invoiceId }, { ledgerId: money, debitPaise: 0, creditPaise: payment.amountPaise }]
    : [{ ledgerId: money, debitPaise: payment.amountPaise, creditPaise: 0 }, { ledgerId: recv, debitPaise: 0, creditPaise: payment.amountPaise, invoiceId: payment.invoiceId }];
}

/** Posts the sales voucher for an invoice (inside the caller's transaction). No-op without a chart of accounts. */
export async function postInvoice(tx: Repositories, invoice: Invoice, actorId?: Id): Promise<Voucher | null> {
  const ledgers = await systemLedgers(tx, invoice.orgId);
  if (!ledgers) return null;
  const org = await tx.orgs.get(invoice.orgId);
  return postVoucher(tx, {
    orgId: invoice.orgId, branchId: invoice.branchId, type: "sales", date: invoice.issuedAt ?? new Date(),
    narration: `Invoice ${invoice.invoiceNo}`, entries: salesEntries(invoice, ledgers, Boolean(org?.settings?.interState)), invoiceId: invoice.id,
  }, actorId);
}

/** Posts a receipt (payment) or payment (refund) voucher. No-op without a chart of accounts. */
export async function postPayment(tx: Repositories, payment: Payment, invoiceNo: string, actorId?: Id): Promise<Voucher | null> {
  const ledgers = await systemLedgers(tx, payment.orgId);
  if (!ledgers) return null;
  return postVoucher(tx, {
    orgId: payment.orgId, branchId: payment.branchId, type: payment.kind === "refund" ? "payment" : "receipt", date: payment.receivedAt,
    narration: `${payment.kind === "refund" ? "Refund" : "Payment"} ${payment.mode.toUpperCase()} against ${invoiceNo}`,
    entries: receiptEntries(payment, ledgers), invoiceId: payment.invoiceId, paymentId: payment.id,
  }, actorId);
}

/** Cancels the sales voucher of a cancelled invoice. */
export async function unpostInvoice(tx: Repositories, invoiceId: Id, actorId?: Id): Promise<void> {
  for (const v of await tx.vouchers.find({ invoiceId, type: "sales", status: "posted" } as any)) await cancelVoucher(tx, v.id, actorId);
}


/** Posting with this package's accounting: what the billing workflows do unless `repos.posting` is set. */
export const defaultPostingHook: PostingHook = {
  async invoiceIssued(tx, invoice, actorId) {
    await postInvoice(tx, invoice, actorId);
  },
  async paymentRecorded(tx, payment, invoiceNo, actorId) {
    await postPayment(tx, payment, invoiceNo, actorId);
  },
  async invoiceCancelled(tx, invoiceId, actorId) {
    await unpostInvoice(tx, invoiceId, actorId);
  },
};
