import { Op, QueryTypes, Sequelize, Transaction, type Model, type ModelStatic, type Options } from "sequelize";
import type {
  AuditRepo, CounterRepo, EntryQuery, Filter, InvoiceRepo, LedgerEntryRepo, LedgerRepo, ListOptions, PatientRepo, Repo,
  Repositories, UserRepo, VoucherRepo,
} from "../core/ports";
import type { Id } from "../core/types";
import { defineModels, definitions } from "./models";

export { defineModels, definitions };

export interface PgOptions {
  /** An existing Sequelize instance (dialect "postgres"). Or pass `url`. */
  sequelize?: Sequelize;
  /** postgres://user:pass@host:5432/db */
  url?: string;
  options?: Options;
  /** Default READ COMMITTED; money paths also take row locks (SELECT … FOR UPDATE). */
  isolationLevel?: Transaction.ISOLATION_LEVELS;
  /** Retries after a deadlock or serialization failure (SQLSTATE 40P01 / 40001). Default 3. */
  retries?: number;
}

const RETRYABLE = new Set(["40001", "40P01"]);
const sqlState = (e: any): string | undefined => e?.parent?.code ?? e?.original?.code ?? e?.code;

function dateWhere(from?: Date, to?: Date) {
  if (!from && !to) return {};
  return { date: { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) } };
}

const clean = (o: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

/** Attributes whose "no value" is an explicit null (kept); other nulls are dropped, like MongoDB. */
const keepNull = new Map<string, Set<string>>();
for (const [name, d] of Object.entries(definitions)) {
  keepNull.set(name, new Set(Object.entries(d.attributes).filter(([, a]: any) => a && a.defaultValue === null).map(([k]) => k)));
}

function toEntity<T>(row: Model | null, name: string): T | null {
  if (!row) return null;
  const plain = row.get({ plain: true }) as Record<string, unknown>;
  const keep = keepNull.get(name)!;
  for (const [k, v] of Object.entries(plain)) if (v === null && !keep.has(k)) delete plain[k];
  return plain as T;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function repo<T extends { id: Id }>(model: ModelStatic<Model>, transaction?: Transaction): Repo<T> {
  const t = transaction ? { transaction } : {};
  const name = model.name;
  return {
    async create(data) {
      return toEntity<T>(await model.create(clean(data as any), t), name)!;
    },
    async get(id) {
      return toEntity<T>(await model.findByPk(id, t), name);
    },
    async getMany(ids) {
      if (!ids.length) return [];
      return (await model.findAll({ where: { id: [...ids] }, ...t })).map((r) => toEntity<T>(r, name)!);
    },
    async update(id, patch) {
      const [, rows] = await model.update(clean(patch as any), { where: { id }, returning: true, ...t });
      return toEntity<T>(rows[0] ?? null, name);
    },
    async delete(id) {
      return (await model.destroy({ where: { id }, ...t })) > 0;
    },
    async find(filter: Filter<T> = {}, o: ListOptions<T> = {}) {
      const rows = await model.findAll({
        where: clean(filter as any),
        order: o.sort ? [[o.sort.field, o.sort.dir === "desc" ? "DESC" : "ASC"]] : undefined,
        limit: o.limit,
        offset: o.offset,
        ...t,
      });
      return rows.map((r) => toEntity<T>(r, name)!);
    },
    async findOne(filter) {
      return toEntity<T>(await model.findOne({ where: clean(filter as any), ...t }), name);
    },
    async count(filter = {}) {
      return model.count({ where: clean(filter as any), ...t });
    },
  };
}

export async function createPgRepositories(opts: PgOptions): Promise<Repositories> {
  const sequelize = opts.sequelize ?? new Sequelize(opts.url!, { dialect: "postgres", logging: false, ...opts.options });
  const owned = !opts.sequelize;
  const m = defineModels(sequelize);

  function build(transaction?: Transaction): Repositories {
    const t = transaction ? { transaction } : {};
    const users: UserRepo = {
      ...repo(m.User!, transaction),
      findByEmail: async (orgId, email) => toEntity(await m.User!.findOne({ where: { orgId, email: email.trim().toLowerCase() }, ...t }), "User"),
      findAllByEmail: async (email) => (await m.User!.findAll({ where: { email: email.trim().toLowerCase() }, ...t })).map((r) => toEntity<any>(r, "User")),
    };
    const patients: PatientRepo = {
      ...repo(m.Patient!, transaction),
      async search(orgId, query, limit = 20) {
        const q = query.trim();
        if (!q) return [];
        const like = `%${escapeLike(q)}%`;
        const rows = await m.Patient!.findAll({
          where: { orgId, [Op.or]: [{ name: { [Op.iLike]: like } }, { phone: { [Op.iLike]: like } }, { uhid: { [Op.iLike]: like } }] },
          order: [["updatedAt", "DESC"]],
          limit,
          ...t,
        });
        return rows.map((r) => toEntity<any>(r, "Patient"));
      },
    };
    const invoices: InvoiceRepo = {
      ...repo(m.Invoice!, transaction),
      async getForUpdate(id) {
        // SELECT … FOR UPDATE: concurrent payments on the same invoice wait for each other
        return toEntity(await m.Invoice!.findByPk(id, transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}), "Invoice");
      },
      async listOutstanding(orgId, branchId) {
        const rows = await m.Invoice!.findAll({
          where: { orgId, ...(branchId ? { branchId } : {}), status: ["issued", "partially_paid"], duePaise: { [Op.gt]: 0 } },
          order: [["issuedAt", "ASC"]],
          ...t,
        });
        return rows.map((r) => toEntity<any>(r, "Invoice"));
      },
    };
    const ledgers: LedgerRepo = {
      ...repo(m.Ledger!, transaction),
      findBySystemKey: async (orgId, key) => toEntity(await m.Ledger!.findOne({ where: { orgId, systemKey: key }, ...t }), "Ledger"),
    };
    const vouchers: VoucherRepo = {
      ...repo(m.Voucher!, transaction),
      async listByDate(q, o = {}) {
        const rows = await m.Voucher!.findAll({
          where: { orgId: q.orgId, ...(q.branchId ? { branchId: q.branchId } : {}), ...(q.type ? { type: q.type } : {}), ...(q.includeCancelled ? {} : { status: "posted" }), ...dateWhere(q.from, q.to) },
          order: [["date", "ASC"], ["voucherNo", "ASC"]],
          limit: o.limit,
          offset: o.offset,
          ...t,
        });
        return rows.map((r) => toEntity<any>(r, "Voucher"));
      },
    };
    const entryWhere = (q: EntryQuery) => ({
      orgId: q.orgId, ...(q.branchId ? { branchId: q.branchId } : {}), ...(q.ledgerId ? { ledgerId: q.ledgerId } : {}),
      ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}), ...dateWhere(q.from, q.to),
    });
    const ledgerEntries: LedgerEntryRepo = {
      async insertMany(entries) {
        await m.LedgerEntry!.bulkCreate(entries.map((e) => clean(e as any)), t);
      },
      async deleteByVoucher(voucherId) {
        return m.LedgerEntry!.destroy({ where: { voucherId }, ...t });
      },
      async list(q, o = {}) {
        const rows = await m.LedgerEntry!.findAll({ where: entryWhere(q), order: [["date", "ASC"], ["voucherNo", "ASC"], ["id", "ASC"]], limit: o.limit, offset: o.offset, ...t });
        return rows.map((r) => toEntity<any>(r, "LedgerEntry"));
      },
      async totals(q) {
        const rows: any[] = await m.LedgerEntry!.findAll({
          attributes: ["ledgerId", [sequelize.fn("SUM", sequelize.col("debit_paise")), "debitPaise"], [sequelize.fn("SUM", sequelize.col("credit_paise")), "creditPaise"]],
          where: entryWhere(q),
          group: ["ledger_id"],
          raw: true,
          ...t,
        });
        // SUM() is NUMERIC in PostgreSQL and arrives as a string
        return rows.map((r) => ({ ledgerId: r.ledgerId, debitPaise: Number(r.debitPaise), creditPaise: Number(r.creditPaise) }));
      },
    };
    const audit: AuditRepo = {
      async log(entry) {
        return toEntity<any>(await m.AuditEntry!.create(clean(entry as any), t), "AuditEntry");
      },
      find: repo<any>(m.AuditEntry!, transaction).find,
    };
    const counters: CounterRepo = {
      async next(key) {
        const rows = await sequelize.query<{ seq: number }>(
          `INSERT INTO counters (key, seq) VALUES (:key, 1)
           ON CONFLICT (key) DO UPDATE SET seq = counters.seq + 1
           RETURNING seq`,
          { replacements: { key }, type: QueryTypes.SELECT, ...t },
        );
        return Number(rows[0]!.seq);
      },
      async peek(key) {
        const row: any = await m.Counter!.findByPk(key, t);
        return row ? Number(row.seq) : 0;
      },
    };

    const self: Repositories = {
      backend: "pg",
      orgs: repo(m.Organization!, transaction),
      branches: repo(m.Branch!, transaction),
      users,
      roles: repo(m.Role!, transaction),
      patients,
      doctors: repo(m.Doctor!, transaction),
      bookings: repo(m.Booking!, transaction),
      samples: repo(m.Sample!, transaction),
      reports: repo(m.Report!, transaction),
      invoices,
      payments: repo(m.Payment!, transaction),
      audit,
      counters,
      accountGroups: repo(m.AccountGroup!, transaction),
      ledgers,
      vouchers,
      ledgerEntries,
      async transaction(fn) {
        if (transaction) return fn(self); // already inside one: join it
        const attempts = (opts.retries ?? 3) + 1;
        for (let i = 1; ; i++) {
          try {
            return await sequelize.transaction({ isolationLevel: opts.isolationLevel }, (tx) => fn(build(tx)));
          } catch (e) {
            if (i >= attempts || !RETRYABLE.has(sqlState(e) ?? "")) throw e;
            await new Promise((r) => setTimeout(r, 20 * 2 ** i + Math.random() * 20));
          }
        }
      },
      async sync() {
        await sequelize.sync();
        // fast "contains" search on patient names when pg_trgm is available (best effort)
        try {
          await sequelize.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
          await sequelize.query("CREATE INDEX IF NOT EXISTS patients_name_trgm ON patients USING gin (name gin_trgm_ops)");
        } catch {
          /* extension not permitted: plain btree indexes still apply */
        }
      },
      async close() {
        if (owned) await sequelize.close();
      },
    };
    return self;
  }

  return build();
}
