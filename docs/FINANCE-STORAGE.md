# Finance storage (for finance-kit)

**Audience:** agents and developers working on db-kit or `@mgpl-diagnostics/finance-kit`.

finance-kit holds the money rules (GST, receivables, partner settlements, cash and bank, lock dates,
year-end close, exports). It stores everything through db-kit, so one transaction can cover an
invoice and its voucher on either database. This page lists that storage and the two hooks
finance-kit relies on.

## Entities

Every entity has a UUID `id`, `orgId`, timestamps, and money in integer paise. Each one is a
repository on `Repositories`, on both MongoDB and PostgreSQL.

| Repository | Table / collection | Notes |
| --- | --- | --- |
| `taxRules` | `tax_rules` / `taxrules` | SAC/HSN, taxability and GST rate for an item `code` or a whole `category`, from `effectiveFrom` to `effectiveTo` (inclusive, null = open). Values are configuration the lab's CA must check |
| `customers` | `customers` | B2B customers (hospital, insurer, TPA, corporate). Unique `code` per organisation. `creditLimitPaise` (null = no limit), `creditDays`, own Sundry Debtors `ledgerId`. `getForUpdate` locks the row (credit-limit checks) |
| `partners` | `partners` | Collection centres and franchises. Unique `code`. `branchId` = the branch whose invoices count. Own Sundry Creditors `ledgerId`. Optional `tds` override `{ section, rateBp }` |
| `partnerAgreements` | `partner_agreements` | `revenue_share` (`shareBp`) or `fixed_rate` (`rates[]`, `defaultSharePaise`), effective-dated |
| `settlements` | `settlements` | A partner's month: lines, gross, share, deductions, TDS, net, status, voucher ids. `periodKey` (`<partnerId>:<YYYY-MM>`, null once cancelled) is unique, so a month has at most one live settlement. `getForUpdate` |
| `cashClosings` | `cash_closings` | One per branch per IST day (`day: "2026-10-14"`, unique): book vs counted cash, denominations, the short/excess voucher |
| `bankStatements` · `bankLines` | `bank_statements` · `bank_lines` | Imported statements. A line's `dedupKey` is unique per organisation, so importing the same file twice adds nothing. Match fields: `status`, `matchKind`, `voucherIds`, `settlement` (card / UPI batch and MDR fee) |
| `periodLocks` | `period_locks` | One row per scope: `"org"` or a branch id (unique). `lockedUpTo` is an instant; null = nothing locked |
| `creditNotes` | `credit_notes` | GST credit notes against an invoice: lines by invoice item, CGST/SGST/IGST, unique `noteNo`. `listByDate` |

Dates inside nested arrays are IST day strings (`"2026-10-03"`), because PostgreSQL JSONB would hand
them back as strings anyway.

New fields on existing entities:

| Entity | Field | Meaning |
| --- | --- | --- |
| `Branch` | `stateCode` | GST state code of the branch (falls back to its GSTIN) |
| `Invoice` | `customerId`, `placeOfSupply`, `buyerGstin` | B2B customer, GST place of supply (state code), buyer's GSTIN at the time |
| `Invoice` | `creditedPaise` | sum of credit notes. `duePaise = max(0, total − credited − paid)`; status `credited` when credit notes cover the invoice |
| `InvoiceItem` | `hsnSac`, `taxability` | GST code and treatment of the line, for returns |
| `VoucherType` | `closing` | the year-end voucher; `profitAndLoss` and `gstSummary` leave it out |

New queries: `invoices.listByDate`, `creditNotes.listByDate`, and `excludeVoucherTypes` on
`ledgerEntries.list/totals`.

## Lock dates

`postVoucher` and `cancelVoucher` call `assertPeriodOpen(tx, orgId, branchId, date)` inside their
transaction. It throws `PeriodLockedError` (a `ConflictError`, 409) when the voucher date is on or
before the organisation's or the branch's `lockedUpTo`.

The check holds both lock rows until commit (`periodLocks.hold(orgId, scopes, "share")`), and a lock
change takes them with `"update"`, so a lock moved while a posting is in flight still stops it:

| | PostgreSQL | MongoDB |
| --- | --- | --- |
| Posting | `SELECT … FOR SHARE` (postings don't block each other) | writes the lock document |
| Lock change | `SELECT … FOR UPDATE`: waits for in-flight postings | writes the lock document: concurrent postings conflict and `withTransaction` retries them |

Missing lock rows are created on first use. finance-kit sets lock dates, closes cash days and closes
financial years; the check itself sits next to `postVoucher`, so it moves with the accounting engine.

## Posting hook

The billing workflows (`issueInvoice`, `recordPayment`, `cancelInvoice`) post through a `PostingHook`:

```ts
interface PostingHook {
  invoiceIssued(tx: Repositories, invoice: Invoice, actorId?: string): Promise<void>;
  paymentRecorded(tx: Repositories, payment: Payment, invoiceNo: string, actorId?: string): Promise<void>;
  invoiceCancelled(tx: Repositories, invoiceId: string, actorId?: string): Promise<void>;
}
```

`defaultPostingHook` keeps today's behaviour (`postInvoice` / `postPayment` / `unpostInvoice`). Pass
another one when creating the repositories, so transactions carry it too:

```ts
import { financePosting } from "@mgpl-diagnostics/finance-kit";
const db = await createDb({ backend: "pg", pg: { url }, posting: financePosting });
```

Spreading `{ ...repos, posting }` does **not** reach the `tx` repositories; use the option.
When the accounting engine moves to its own kit (tally-kit), that kit implements this hook and
db-kit no longer imports the engine.

## Upgrading an existing database

db-kit is not published or deployed yet, so a throw-away database can simply be recreated. For a
database you want to keep:

**PostgreSQL** (`sync()` creates new tables but does not add columns to existing ones). Run before
`sync()`:

```sql
ALTER TABLE branches ADD COLUMN IF NOT EXISTS state_code VARCHAR(2);
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS customer_id UUID,
  ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(2),
  ADD COLUMN IF NOT EXISTS buyer_gstin VARCHAR(15),
  ADD COLUMN IF NOT EXISTS credited_paise INTEGER NOT NULL DEFAULT 0;
```

then, after `sync()` has created `customers`:

```sql
ALTER TABLE invoices ADD CONSTRAINT invoices_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT ON UPDATE CASCADE;
```

**MongoDB:** `sync()` builds the new indexes. Old invoices have no `creditedPaise`; readers treat it
as 0, or set it once: `db.invoices.updateMany({ creditedPaise: { $exists: false } }, { $set: { creditedPaise: 0 } })`.
