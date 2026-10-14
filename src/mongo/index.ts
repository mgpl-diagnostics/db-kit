import mongoose, { type ClientSession, type Connection, type ConnectOptions, type Model } from "mongoose";

/** The driver's TransactionOptions, without depending on the "mongodb" package directly. */
type TransactionOptions = NonNullable<Parameters<ClientSession["withTransaction"]>[1]>;
import { randomUUID } from "node:crypto";
import type {
  AuditRepo, CounterRepo, CreditNoteRepo, DateQuery, EntryQuery, Filter, InvoiceRepo, LedgerEntryRepo, LedgerRepo, ListOptions, LockableRepo,
  PatientRepo, PeriodLockRepo, PostingHook, Repo, Repositories, UserRepo, VoucherRepo,
} from "../core/ports";
import type { Id } from "../core/types";
import { registerModels, schemas, type ModelName } from "./schemas";

export { schemas, registerModels };

export interface MongoOptions {
  /** An existing connection (mongoose.createConnection). Or pass `uri`. */
  connection?: Connection;
  uri?: string;
  options?: ConnectOptions;
  /**
   * Transactions need a replica set (a single-node replica set is enough). By default
   * repos.transaction() throws on a standalone server rather than silently giving up atomicity.
   * Set true only for throw-away development databases.
   */
  allowNoTransactions?: boolean;
  /** Defaults: snapshot reads, majority writes, primary reads. */
  transactionOptions?: TransactionOptions;
  /** Posting for invoices and payments (e.g. finance-kit's). Default: this package's accounting. */
  posting?: PostingHook;
}

export class TransactionsUnsupportedError extends Error {
  constructor() {
    super(
      "MongoDB transactions need a replica set. Start mongod with --replSet rs0 and run rs.initiate() " +
        "(one node is enough), or pass allowNoTransactions: true for a throw-away dev database.",
    );
    this.name = "TransactionsUnsupportedError";
  }
}

/** _id → id, drop internals. */
function toEntity<T>(doc: any): T {
  if (!doc) return doc;
  const { _id, lockVersion, ...rest } = doc;
  return { id: _id, ...rest } as T;
}

const clean = (o: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== "id") out[k] = v;
  return out;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mapFilter(filter: Record<string, unknown>) {
  const rest = clean(filter);
  return "id" in filter && filter.id !== undefined ? { _id: filter.id, ...rest } : rest;
}

const dateRange = (from?: Date, to?: Date) =>
  from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};

function entryMatch(q: EntryQuery) {
  return {
    orgId: q.orgId,
    ...(q.branchId ? { branchId: q.branchId } : {}),
    ...(q.ledgerId ? { ledgerId: q.ledgerId } : {}),
    ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
    ...(q.excludeVoucherTypes?.length ? { voucherType: { $nin: q.excludeVoucherTypes } } : {}),
    ...dateRange(q.from, q.to),
  };
}

const fieldRange = (field: string, from?: Date, to?: Date) =>
  from || to ? { [field]: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};

const scoped = (q: DateQuery) => ({ orgId: q.orgId, ...(q.branchId ? { branchId: q.branchId } : {}) });

/** A write inside the transaction takes the document's lock until commit (MongoDB has no SELECT … FOR UPDATE). */
function lockable<T extends { id: Id }>(model: Model<any>, session?: ClientSession): LockableRepo<T> {
  return {
    ...repo<T>(model, session),
    async getForUpdate(id) {
      if (!session) return toEntity<T>(await model.findById(id).lean());
      return toEntity<T>(await model.findOneAndUpdate({ _id: id }, { $inc: { lockVersion: 1 } }, { returnDocument: "after", session, timestamps: false }).lean());
    },
  };
}

function repo<T extends { id: Id }>(model: Model<any>, session?: ClientSession): Repo<T> {
  const s = session ? { session } : {};
  return {
    async create(data) {
      const { id, ...rest } = data as any;
      const [doc] = await model.create([{ ...clean(rest), ...(id ? { _id: id } : {}) }], s);
      return toEntity<T>(doc.toObject());
    },
    async get(id) {
      return toEntity<T>(await model.findById(id, null, s).lean());
    },
    async getMany(ids) {
      if (!ids.length) return [];
      return (await model.find({ _id: { $in: [...ids] } }, null, s).lean()).map((d: any) => toEntity<T>(d));
    },
    async update(id, patch) {
      return toEntity<T>(await model.findByIdAndUpdate(id, { $set: clean(patch as any) }, { new: true, runValidators: true, ...s }).lean());
    },
    async delete(id) {
      return (await model.deleteOne({ _id: id }, s)).deletedCount === 1;
    },
    async find(filter: Filter<T> = {}, o: ListOptions<T> = {}) {
      const q = model.find(mapFilter(filter), null, s).lean();
      if (o.sort) q.sort({ [o.sort.field === "id" ? "_id" : o.sort.field]: o.sort.dir === "desc" ? -1 : 1 });
      if (o.offset) q.skip(o.offset);
      if (o.limit) q.limit(o.limit);
      return (await q).map((d: any) => toEntity<T>(d));
    },
    async findOne(filter) {
      return toEntity<T>(await model.findOne(mapFilter(filter), null, s).lean());
    },
    async count(filter = {}) {
      return model.countDocuments(mapFilter(filter), s);
    },
  };
}

export async function createMongoRepositories(opts: MongoOptions): Promise<Repositories> {
  const connection = opts.connection ?? (await mongoose.createConnection(opts.uri!, opts.options).asPromise());
  const owned = !opts.connection;
  const models = registerModels(connection);
  const txOptions: TransactionOptions = {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    readPreference: "primary",
    ...opts.transactionOptions,
  };
  let supportsTx: boolean | undefined;

  async function transactionsSupported() {
    if (supportsTx === undefined) {
      const hello = await connection.db!.admin().command({ hello: 1 });
      supportsTx = Boolean(hello.setName || hello.msg === "isdbgrid");
    }
    return supportsTx;
  }

  function build(session?: ClientSession): Repositories {
    const s = session ? { session } : {};
    const users: UserRepo = {
      ...repo(models.User, session),
      findByEmail: async (orgId, email) => toEntity(await models.User.findOne({ orgId, email: email.trim().toLowerCase() }, null, s).lean()),
      findAllByEmail: async (email) => (await models.User.find({ email: email.trim().toLowerCase() }, null, s).lean()).map((d) => toEntity(d)),
    };
    const patients: PatientRepo = {
      ...repo(models.Patient, session),
      async search(orgId, query, limit = 20) {
        const q = query.trim();
        if (!q) return [];
        const re = new RegExp(escapeRegex(q), "i");
        const docs = await models.Patient.find({ orgId, $or: [{ name: re }, { phone: re }, { uhid: re }] }, null, s).sort({ updatedAt: -1 }).limit(limit).lean();
        return docs.map((d) => toEntity(d));
      },
    };
    const invoices: InvoiceRepo = {
      ...lockable(models.Invoice, session),
      async listOutstanding(orgId, branchId) {
        const docs = await models.Invoice.find({ orgId, ...(branchId ? { branchId } : {}), status: { $in: ["issued", "partially_paid"] }, duePaise: { $gt: 0 } }, null, s).sort({ issuedAt: 1 }).lean();
        return docs.map((d) => toEntity(d));
      },
      async listByDate(q) {
        const docs = await models.Invoice.find({
          ...scoped(q), ...(q.customerId ? { customerId: q.customerId } : {}), ...fieldRange("issuedAt", q.from, q.to),
          status: q.includeCancelled ? { $ne: "draft" } : { $nin: ["draft", "cancelled"] },
        }, null, s).sort({ issuedAt: 1, invoiceNo: 1 }).lean();
        return docs.map((d) => toEntity(d));
      },
    };
    const creditNotes: CreditNoteRepo = {
      ...repo(models.CreditNote, session),
      async listByDate(q) {
        const docs = await models.CreditNote.find({ ...scoped(q), ...fieldRange("date", q.from, q.to), ...(q.includeCancelled ? {} : { status: "issued" }) }, null, s)
          .sort({ date: 1, noteNo: 1 }).lean();
        return docs.map((d) => toEntity(d));
      },
    };
    const periodLocks: PeriodLockRepo = {
      ...repo(models.PeriodLock, session),
      async hold(orgId, scopes) {
        // Both modes write the lock document: in MongoDB only a write makes a concurrent writer conflict.
        const out = [];
        for (const scope of [...new Set(scopes)].sort()) {
          const now = new Date();
          const doc = await models.PeriodLock.findOneAndUpdate(
            { orgId, scope },
            { $inc: { lockVersion: 1 }, $setOnInsert: { _id: randomUUID(), branchId: scope === "org" ? null : scope, lockedUpTo: null, updatedBy: null, createdAt: now, updatedAt: now } },
            { upsert: true, returnDocument: "after", timestamps: false, ...s },
          ).lean();
          out.push(toEntity<any>(doc));
        }
        return out;
      },
    };
    const audit: AuditRepo = {
      async log(entry) {
        const [doc] = await models.AuditEntry.create([clean(entry as any)], s);
        return toEntity(doc.toObject());
      },
      find: repo<any>(models.AuditEntry, session).find,
    };
    const counters: CounterRepo = {
      async next(key) {
        const doc: any = await models.Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true, ...s }).lean();
        return doc.seq;
      },
      async peek(key) {
        const doc: any = await models.Counter.findById(key, null, s).lean();
        return doc?.seq ?? 0;
      },
    };
    const ledgers: LedgerRepo = {
      ...repo(models.Ledger, session),
      findBySystemKey: async (orgId, key) => toEntity(await models.Ledger.findOne({ orgId, systemKey: key }, null, s).lean()),
    };
    const vouchers: VoucherRepo = {
      ...repo(models.Voucher, session),
      async listByDate(q, o = {}) {
        const query = models.Voucher.find({
          orgId: q.orgId, ...(q.branchId ? { branchId: q.branchId } : {}), ...(q.type ? { type: q.type } : {}),
          ...(q.includeCancelled ? {} : { status: "posted" }), ...dateRange(q.from, q.to),
        }, null, s).sort({ date: 1, voucherNo: 1 }).lean();
        if (o.offset) query.skip(o.offset);
        if (o.limit) query.limit(o.limit);
        return (await query).map((d) => toEntity(d));
      },
    };
    const ledgerEntries: LedgerEntryRepo = {
      async insertMany(entries) {
        await models.LedgerEntry.insertMany(entries.map((e) => clean(e as any)), s);
      },
      async deleteByVoucher(voucherId) {
        return (await models.LedgerEntry.deleteMany({ voucherId }, s)).deletedCount;
      },
      async list(q, o = {}) {
        const query = models.LedgerEntry.find(entryMatch(q), null, s).sort({ date: 1, voucherNo: 1, _id: 1 }).lean();
        if (o.offset) query.skip(o.offset);
        if (o.limit) query.limit(o.limit);
        return (await query).map((d) => toEntity(d));
      },
      async totals(q) {
        const rows = await models.LedgerEntry.aggregate([
          { $match: entryMatch(q) },
          { $group: { _id: "$ledgerId", debitPaise: { $sum: "$debitPaise" }, creditPaise: { $sum: "$creditPaise" } } },
        ]).session(session ?? null);
        return rows.map((r: any) => ({ ledgerId: r._id, debitPaise: r.debitPaise, creditPaise: r.creditPaise }));
      },
    };

    const self: Repositories = {
      backend: "mongo",
      orgs: repo(models.Organization, session),
      branches: repo(models.Branch, session),
      users,
      roles: repo(models.Role, session),
      patients,
      doctors: repo(models.Doctor, session),
      bookings: repo(models.Booking, session),
      samples: repo(models.Sample, session),
      reports: repo(models.Report, session),
      invoices,
      payments: repo(models.Payment, session),
      audit,
      counters,
      accountGroups: repo(models.AccountGroup, session),
      ledgers,
      vouchers,
      ledgerEntries,
      taxRules: repo(models.TaxRule, session),
      customers: lockable(models.Customer, session),
      partners: repo(models.Partner, session),
      partnerAgreements: repo(models.PartnerAgreement, session),
      settlements: lockable(models.Settlement, session),
      cashClosings: repo(models.CashClosing, session),
      bankStatements: repo(models.BankStatement, session),
      bankLines: repo(models.BankLine, session),
      periodLocks,
      creditNotes,
      posting: opts.posting,
      async transaction(fn) {
        if (session) return fn(self); // already inside one: join it
        if (!(await transactionsSupported())) {
          if (opts.allowNoTransactions) return fn(self);
          throw new TransactionsUnsupportedError();
        }
        const sess = await connection.startSession();
        try {
          let result: any;
          // withTransaction retries on TransientTransactionError / UnknownTransactionCommitResult
          await sess.withTransaction(async () => {
            result = await fn(build(sess));
          }, txOptions);
          return result;
        } finally {
          await sess.endSession();
        }
      },
      async sync() {
        // collections must exist before they are used inside a transaction
        for (const name of Object.keys(schemas) as ModelName[]) await models[name].syncIndexes();
      },
      async close() {
        if (owned) await connection.close();
      },
    };
    return self;
  }

  return build();
}
