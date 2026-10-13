// GraphQL module tests: a real Yoga server in memory, viewers chosen by a test header.
import { createYoga } from "graphql-yoga";
import { seedChartOfAccounts, seedOrganization, type Db, type Repositories, type RoleAssignment } from "../src/index";
import { createSchema, dbModule, type DbGraphQLContext } from "../src/graphql/index";

type Ok = (cond: unknown, msg: string) => void;

const PERMS: Record<string, string[]> = {
  owner: ["*:*"],
  front_desk: ["patient:read", "patient:create", "booking:read", "booking:create", "invoice:read", "invoice:create", "payment:create"],
};
const match = (g: string, w: string) => {
  const [gr, ga] = g.split(":");
  const [wr, wa] = w.split(":");
  return (gr === "*" || gr === wr) && (ga === "*" || ga === wa);
};
const can = (roles: RoleAssignment[], perm: string, branchId?: string | null) =>
  roles.some((a) => (!branchId || !a.branchId || a.branchId === branchId) && (PERMS[a.role] ?? []).some((g) => match(g, perm)));

export async function graphqlSuite(db: Db, ok: Ok) {
  const tag = `[graphql/${db.backend}]`;
  console.log(`\n${tag}`);
  let getManyCalls = 0;
  const repos: Repositories = {
    ...db.rawRepos,
    patients: { ...db.rawRepos.patients, getMany: (ids) => { getManyCalls++; return db.rawRepos.patients.getMany(ids); } },
  };

  const a = await seedOrganization(repos, { org: { name: "GQL Lab", code: "GQL" }, branch: { code: "A01", name: "Branch A" }, owner: { name: "O", email: "o@gql.in", passwordHash: "h" } });
  const b2 = await repos.branches.create({ orgId: a.org.id, code: "B01", name: "Branch B", kind: "collection_center", active: true });
  await seedChartOfAccounts(repos, a.org.id);
  const other = await seedOrganization(repos, { org: { name: "Other Lab", code: "OTH" }, branch: { code: "Z01", name: "Z" }, owner: { name: "X", email: "x@oth.in", passwordHash: "h" } });
  const cash = (await repos.ledgers.findBySystemKey(a.org.id, "cash"))!;
  const capital = (await repos.ledgers.findBySystemKey(a.org.id, "capital"))!;

  const viewers: Record<string, { userId: string; orgId: string; roles: RoleAssignment[] }> = {
    owner: { userId: a.owner.id, orgId: a.org.id, roles: [{ role: "owner", branchId: null }] },
    desk: { userId: "0b0b0b0b-0000-4000-8000-00000000d35c", orgId: a.org.id, roles: [{ role: "front_desk", branchId: a.branch.id }] },
    other: { userId: other.owner.id, orgId: other.org.id, roles: [{ role: "owner", branchId: null }] },
  };
  const yoga = createYoga<{ request: Request }, DbGraphQLContext>({
    schema: createSchema([dbModule]),
    logging: false,
    context: ({ request }) => {
      const v = viewers[request.headers.get("x-test-user") ?? ""] ?? null;
      return {
        repos,
        viewer: v,
        can: (p, br) => !!v && can(v.roles, p, br),
        branchesFor: (p) => {
          if (!v) return [];
          if (v.roles.some((r) => !r.branchId && can([r], p))) return "all";
          return v.roles.filter((r) => r.branchId && can([r], p, r.branchId)).map((r) => r.branchId!);
        },
      };
    },
  });
  const gql = async (user: string | null, query: string, variables?: Record<string, unknown>) => {
    const res = await yoga.fetch("http://test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
  };
  const code = (r: { errors?: { extensions?: { code?: string } }[] }) => r.errors?.[0]?.extensions?.code;

  ok(code(await gql(null, "{ organization { name } }")) === "UNAUTHENTICATED", `${tag} no viewer → UNAUTHENTICATED`);
  const org = await gql("owner", "{ organization { name code branches { code } } }");
  ok(org.data?.organization.code === "GQL" && org.data.organization.branches.length === 2, `${tag} organization with branches`);

  const reg = await gql("owner", "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { id uhid name sex } }", {
    i: { branchId: a.branch.id, name: "Asha Patel", sex: "female", ageYears: 29, phone: "9111111111" },
  });
  const patientId = reg.data?.registerPatient.id;
  ok(reg.data?.registerPatient.uhid === "GQL-000001", `${tag} registerPatient → ${reg.data?.registerPatient.uhid}`);

  const book = await gql("owner", "mutation($i: CreateBookingInput!) { createBooking(input: $i) { booking { id bookingNo status patient { name } } samples { barcode sampleType } } }", {
    i: { branchId: a.branch.id, patientId, tests: [{ testCode: "CBC", name: "CBC", pricePaise: 39900, sampleType: "EDTA" }, { testCode: "HBA1C", name: "HbA1c", pricePaise: 54900, sampleType: "EDTA" }] },
  });
  const bookingId = book.data?.createBooking.booking.id;
  ok(book.data?.createBooking.samples.length === 1 && book.data.createBooking.booking.patient.name === "Asha Patel", `${tag} createBooking ${book.data?.createBooking.booking.bookingNo}: one EDTA sample`);

  const inv = await gql("owner", "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id invoiceNo status totalPaise paidPaise duePaise } }", {
    i: { branchId: a.branch.id, patientId, bookingId, items: [{ code: "CBC", name: "CBC", ratePaise: 39900 }, { code: "HBA1C", name: "HbA1c", ratePaise: 54900 }], payments: [{ amountPaise: 50000, mode: "cash" }] },
  });
  const invoiceId = inv.data?.issueInvoice.id;
  ok(inv.data?.issueInvoice.status === "partially_paid" && inv.data.issueInvoice.totalPaise === 94800, `${tag} issueInvoice ${inv.data?.issueInvoice.invoiceNo}: Rs 948, partially paid`);
  const over = await gql("owner", "mutation($id: ID!) { recordPayment(invoiceId: $id, payment: { amountPaise: 999999, mode: upi }) { id } }", { id: invoiceId });
  ok(code(over) === "CONFLICT", `${tag} overpayment → CONFLICT`);
  const pay = await gql("owner", 'mutation($id: ID!) { recordPayment(invoiceId: $id, payment: { amountPaise: 44800, mode: upi, reference: "UPI9" }) { status duePaise payments { mode amountPaise } vouchers { type voucherNo entries { ledger { name } debitPaise creditPaise } } } }', { id: invoiceId });
  const p = pay.data?.recordPayment;
  ok(p?.status === "paid" && p.payments.length === 2 && p.vouchers.length === 3, `${tag} recordPayment → paid; 2 payments, 3 vouchers (sales + 2 receipts)`);
  ok(p?.vouchers.find((v: any) => v.type === "sales")?.entries.some((e: any) => e.ledger.name === "Patient Receivables"), `${tag} voucher entries resolve their ledgers`);

  const books = await gql("owner", '{ trialBalance { differencePaise totalDebitPaise } gstSummary(from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z") { totalTaxPaise } outstandingReceivables { totalDuePaise } }');
  ok(books.data?.trialBalance.differencePaise === 0 && books.data.trialBalance.totalDebitPaise > 0 && books.data.outstandingReceivables.totalDuePaise === 0, `${tag} trial balance balances; nothing outstanding`);
  const unbalanced = await gql("owner", "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id } }", {
    i: { branchId: a.branch.id, type: "journal", entries: [{ ledgerId: cash.id, debitPaise: 100 }, { ledgerId: capital.id, creditPaise: 50 }] },
  });
  ok(code(unbalanced) === "BAD_USER_INPUT", `${tag} unbalanced voucher → BAD_USER_INPUT`);
  const foreignLedger = await gql("other", "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id } }", {
    i: { branchId: other.branch.id, type: "journal", entries: [{ ledgerId: cash.id, debitPaise: 100 }, { ledgerId: capital.id, creditPaise: 100 }] },
  });
  ok(code(foreignLedger) === "NOT_FOUND", `${tag} cannot post into another organisation's ledgers`);
  const badQty = await gql("owner", "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, items: [{ name: "X", qty: 0, ratePaise: 100 }] } });
  ok(code(badQty) === "BAD_USER_INPUT", `${tag} qty 0 → BAD_USER_INPUT`);

  // permissions: front desk limited to branch A
  ok(code(await gql("desk", "{ trialBalance { differencePaise } }")) === "FORBIDDEN", `${tag} front desk cannot read the books → FORBIDDEN`);
  const deskA = await gql("desk", "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { uhid } }", { i: { branchId: a.branch.id, name: "Walk In", sex: "male" } });
  const deskB = await gql("desk", "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { uhid } }", { i: { branchId: b2.id, name: "Walk In", sex: "male" } });
  ok(deskA.data?.registerPatient.uhid && code(deskB) === "FORBIDDEN", `${tag} front desk registers in branch A, not branch B`);
  const deskList = await gql("desk", "{ invoices { id branch { code } } }");
  ok(Array.isArray(deskList.data?.invoices) && deskList.data.invoices.every((i: any) => i.branch.code === "A01"), `${tag} lists only show the viewer's branches`);
  const discount = await gql("desk", "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, items: [{ name: "X", ratePaise: 1000 }], billDiscountPaise: 100 } });
  ok(code(discount) === "FORBIDDEN", `${tag} discounts need invoice:discount`);

  // tenant isolation
  ok(code(await gql("other", "query($id: ID!) { invoice(id: $id) { id } }", { id: invoiceId })) === "NOT_FOUND", `${tag} another organisation cannot read this invoice`);
  ok((await gql("other", "query($id: ID!) { patient(id: $id) { id } }", { id: patientId })).data?.patient === null, `${tag} …or this patient`);

  // N+1: 10 invoices with their patients → one batched lookup
  for (let i = 0; i < 9; i++) await gql("owner", "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, items: [{ name: "T", ratePaise: 1000 }] } });
  getManyCalls = 0;
  const list = await gql("owner", "{ invoices(limit: 10) { invoiceNo patient { name } } }");
  ok(list.data?.invoices.length === 10 && getManyCalls === 1, `${tag} 10 invoices → ${getManyCalls} batched patient query (no N+1)`);
}
