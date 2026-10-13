import { DataTypes, type ModelAttributes, type ModelStatic, type Model, type Sequelize } from "sequelize";

/**
 * Sequelize models for PostgreSQL. camelCase attributes, snake_case columns (underscored),
 * UUID primary keys, real foreign keys, JSONB for nested values. Money is INTEGER paise
 * (≤ ₹2.1 crore per row; BIGINT would come back as strings).
 */

const { UUID, UUIDV4, STRING, TEXT, BOOLEAN, INTEGER, DATE, JSONB, ARRAY } = DataTypes;

// Factories, not shared objects: Sequelize mutates each attribute definition it receives (it sets the
// column name on it), so one object reused for several columns makes them all write to one column.
const id = () => ({ type: UUID, defaultValue: UUIDV4, primaryKey: true });
const ref = (table: string, allowNull = false) => ({ type: UUID, allowNull, references: { model: table, key: "id" }, onDelete: "RESTRICT", onUpdate: "CASCADE" });
const oneOf = (...values: string[]) => ({ type: STRING(32), allowNull: false, validate: { isIn: [values] } });
const nullable = (type: any) => ({ type, allowNull: true, defaultValue: null });
const money = () => ({ type: INTEGER, allowNull: false, defaultValue: 0 });

interface Def {
  table: string;
  attributes: ModelAttributes;
  indexes?: { fields: string[]; unique?: boolean; name?: string }[];
  timestamps?: boolean;
}

export const definitions: Record<string, Def> = {
  Organization: {
    table: "organizations",
    attributes: {
      id: id(), name: { type: STRING, allowNull: false }, legalName: STRING, gstin: STRING(15), phone: STRING(20), email: STRING,
      address: JSONB, code: { type: STRING(16), allowNull: false, unique: true }, settings: { type: JSONB, allowNull: false, defaultValue: {} },
    },
  },
  Branch: {
    table: "branches",
    attributes: {
      id: id(), orgId: ref("organizations"), code: { type: STRING(16), allowNull: false }, name: { type: STRING, allowNull: false },
      kind: { ...oneOf("lab", "collection_center"), defaultValue: "lab" }, phone: STRING(20), gstin: STRING(15), address: JSONB,
      active: { type: BOOLEAN, allowNull: false, defaultValue: true },
    },
    indexes: [{ fields: ["org_id", "code"], unique: true }],
  },
  User: {
    table: "users",
    attributes: {
      id: id(), orgId: ref("organizations"), name: { type: STRING, allowNull: false }, email: { type: STRING, allowNull: false }, phone: STRING(20),
      passwordHash: { type: STRING, allowNull: false }, status: { ...oneOf("active", "disabled", "invited"), defaultValue: "active" },
      roles: { type: JSONB, allowNull: false, defaultValue: [] }, lastLoginAt: nullable(DATE),
    },
    indexes: [{ fields: ["org_id", "email"], unique: true }, { fields: ["email"] }],
  },
  Role: {
    table: "roles",
    attributes: {
      id: id(), orgId: ref("organizations"), key: { type: STRING(64), allowNull: false }, name: { type: STRING, allowNull: false },
      permissions: { type: ARRAY(TEXT), allowNull: false, defaultValue: [] }, system: { type: BOOLEAN, allowNull: false, defaultValue: false },
    },
    indexes: [{ fields: ["org_id", "key"], unique: true }],
  },
  Patient: {
    table: "patients",
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"), uhid: { type: STRING(32), allowNull: false }, title: STRING(16),
      name: { type: STRING, allowNull: false }, sex: oneOf("male", "female", "other"), dob: nullable(DATE), ageYears: nullable(INTEGER),
      phone: STRING(20), email: STRING, address: JSONB,
    },
    indexes: [{ fields: ["org_id", "uhid"], unique: true }, { fields: ["org_id", "phone"] }, { fields: ["org_id", "name"] }],
  },
  Doctor: {
    table: "doctors",
    attributes: {
      id: id(), orgId: ref("organizations"), name: { type: STRING, allowNull: false }, qualification: STRING, phone: STRING(20), clinic: STRING,
      active: { type: BOOLEAN, allowNull: false, defaultValue: true },
    },
    indexes: [{ fields: ["org_id", "name"] }],
  },
  Booking: {
    table: "bookings",
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"), bookingNo: { type: STRING(32), allowNull: false },
      patientId: ref("patients"), doctorId: { ...ref("doctors", true), defaultValue: null }, tests: { type: JSONB, allowNull: false, defaultValue: [] },
      sampleCollection: { type: JSONB, allowNull: false, defaultValue: { type: "walk_in" } },
      status: { ...oneOf("booked", "sample_collected", "in_process", "completed", "cancelled"), defaultValue: "booked" },
      invoiceId: nullable(UUID), createdBy: nullable(UUID), notes: TEXT,
    },
    indexes: [{ fields: ["org_id", "booking_no"], unique: true }, { fields: ["branch_id", "created_at"] }, { fields: ["patient_id"] }, { fields: ["org_id", "status"] }],
  },
  Sample: {
    table: "samples",
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"), bookingId: ref("bookings"), barcode: { type: STRING(32), allowNull: false },
      sampleType: { type: STRING(64), allowNull: false }, status: { ...oneOf("pending", "collected", "received", "rejected"), defaultValue: "pending" },
      collectedAt: nullable(DATE), collectedBy: nullable(UUID), receivedAt: nullable(DATE), rejectReason: nullable(TEXT),
    },
    indexes: [{ fields: ["org_id", "barcode"], unique: true }, { fields: ["booking_id"] }],
  },
  Report: {
    table: "reports",
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"), bookingId: ref("bookings"), patientId: ref("patients"),
      testCode: { type: STRING(64), allowNull: false }, testName: { type: STRING, allowNull: false }, results: { type: JSONB, allowNull: false, defaultValue: [] },
      status: { ...oneOf("draft", "entered", "verified", "released", "amended"), defaultValue: "draft" },
      enteredBy: nullable(UUID), verifiedBy: nullable(UUID), verifiedAt: nullable(DATE), releasedAt: nullable(DATE),
      version: { type: INTEGER, allowNull: false, defaultValue: 1 },
    },
    indexes: [{ fields: ["booking_id"] }, { fields: ["patient_id", "created_at"] }, { fields: ["org_id", "status"] }],
  },
  Invoice: {
    table: "invoices",
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"), invoiceNo: { type: STRING(48), allowNull: false },
      patientId: ref("patients"), bookingId: { ...ref("bookings", true), defaultValue: null }, items: { type: JSONB, allowNull: false, defaultValue: [] },
      subtotalPaise: money(), discountPaise: money(), taxPaise: money(), roundOffPaise: money(), totalPaise: money(), paidPaise: money(), duePaise: money(),
      status: { ...oneOf("draft", "issued", "partially_paid", "paid", "cancelled", "refunded"), defaultValue: "issued" },
      issuedAt: nullable(DATE), createdBy: nullable(UUID), cancelReason: nullable(TEXT),
    },
    indexes: [{ fields: ["org_id", "invoice_no"], unique: true }, { fields: ["patient_id"] }, { fields: ["branch_id", "issued_at"] }, { fields: ["org_id", "status"] }],
  },
  Payment: {
    table: "payments",
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"), invoiceId: ref("invoices"),
      kind: { ...oneOf("payment", "refund"), defaultValue: "payment" }, amountPaise: { type: INTEGER, allowNull: false, validate: { min: 1 } },
      mode: oneOf("cash", "upi", "card", "netbanking", "wallet", "cheque", "insurance"), reference: STRING,
      receivedBy: nullable(UUID), receivedAt: { type: DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    indexes: [{ fields: ["invoice_id"] }, { fields: ["branch_id", "received_at"] }],
  },
  AuditEntry: {
    table: "audit_log",
    timestamps: false,
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: nullable(UUID), userId: nullable(UUID), action: { type: STRING(64), allowNull: false },
      entity: STRING(32), entityId: nullable(UUID), ip: STRING(64), data: JSONB, at: { type: DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    indexes: [{ fields: ["org_id", "at"] }, { fields: ["entity", "entity_id"] }],
  },
  // ---- accounting (Tally-style)
  AccountGroup: {
    table: "account_groups",
    attributes: {
      id: id(), orgId: ref("organizations"), name: { type: STRING, allowNull: false }, parentId: { ...ref("account_groups", true), defaultValue: null },
      nature: oneOf("assets", "liabilities", "income", "expenses"), affectsGrossProfit: { type: BOOLEAN, allowNull: false, defaultValue: false },
      system: { type: BOOLEAN, allowNull: false, defaultValue: false },
    },
    indexes: [{ fields: ["org_id", "name"], unique: true }],
  },
  Ledger: {
    table: "ledgers",
    attributes: {
      id: id(), orgId: ref("organizations"), name: { type: STRING, allowNull: false }, groupId: ref("account_groups"),
      openingPaise: { type: INTEGER, allowNull: false, defaultValue: 0 }, systemKey: nullable(STRING(32)), gstin: STRING(15),
      active: { type: BOOLEAN, allowNull: false, defaultValue: true },
    },
    // PostgreSQL unique indexes allow many NULLs, so only real system keys are constrained
    indexes: [{ fields: ["org_id", "name"], unique: true }, { fields: ["org_id", "system_key"], unique: true }],
  },
  Voucher: {
    table: "vouchers",
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"),
      type: oneOf("sales", "receipt", "payment", "journal", "contra", "credit_note", "debit_note", "purchase"),
      voucherNo: { type: STRING(48), allowNull: false }, date: { type: DATE, allowNull: false }, narration: TEXT,
      entries: { type: JSONB, allowNull: false, defaultValue: [] }, invoiceId: { ...ref("invoices", true), defaultValue: null },
      paymentId: { ...ref("payments", true), defaultValue: null }, status: { ...oneOf("posted", "cancelled"), defaultValue: "posted" },
      createdBy: nullable(UUID),
    },
    indexes: [{ fields: ["org_id", "voucher_no"], unique: true }, { fields: ["org_id", "date"] }, { fields: ["invoice_id"] }],
  },
  LedgerEntry: {
    table: "ledger_entries",
    timestamps: false,
    attributes: {
      id: id(), orgId: ref("organizations"), branchId: ref("branches"), voucherId: ref("vouchers"), voucherType: { type: STRING(16), allowNull: false },
      voucherNo: { type: STRING(48), allowNull: false }, ledgerId: ref("ledgers"), date: { type: DATE, allowNull: false },
      debitPaise: { type: INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
      creditPaise: { type: INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
      invoiceId: nullable(UUID),
    },
    indexes: [{ fields: ["org_id", "ledger_id", "date"] }, { fields: ["org_id", "date"] }, { fields: ["voucher_id"] }, { fields: ["invoice_id"] }],
  },
  Counter: {
    table: "counters",
    timestamps: false,
    attributes: { key: { type: STRING(128), primaryKey: true }, seq: { type: INTEGER, allowNull: false, defaultValue: 0 } },
  },
};

export type PgModelName = keyof typeof definitions;

/** Defines every model on a Sequelize instance (idempotent), in foreign-key order. */
export function defineModels(sequelize: Sequelize): Record<string, ModelStatic<Model>> {
  const out: Record<string, ModelStatic<Model>> = {};
  for (const [name, d] of Object.entries(definitions)) {
    out[name] = sequelize.models[name] ?? sequelize.define(name, d.attributes, {
      tableName: d.table,
      underscored: true,
      timestamps: d.timestamps ?? true,
      indexes: d.indexes,
    });
  }
  return out;
}
