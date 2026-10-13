/**
 * GraphQL schema for the data layer. Money is Int paise (₹1 = 100). Dates are ISO-8601 DateTime.
 * Everything is scoped to the signed-in user's organisation; no query takes an orgId.
 */
export const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  enum Sex { male female other }
  enum BranchKind { lab collection_center }
  enum BookingStatus { booked sample_collected in_process completed cancelled }
  enum CollectionType { walk_in home }
  enum SampleStatus { pending collected received rejected }
  enum ReportStatus { draft entered verified released amended }
  enum InvoiceStatus { draft issued partially_paid paid cancelled refunded }
  enum ItemCategory { test package service consumable medicine other }
  enum PaymentMode { cash upi card netbanking wallet cheque insurance }
  enum PaymentKind { payment refund }
  enum ResultFlag { L H A NONE }
  enum AccountNature { assets liabilities income expenses }
  enum VoucherType { sales receipt payment journal contra credit_note debit_note purchase }
  enum VoucherStatus { posted cancelled }
  enum AgeBucket { D0_30 D31_60 D61_90 D90_PLUS }

  type Address { line1: String, line2: String, city: String, district: String, state: String, pincode: String }

  type Organization {
    id: ID!
    name: String!
    code: String!
    legalName: String
    gstin: String
    phone: String
    email: String
    address: Address
    branches: [Branch!]!
  }

  type Branch { id: ID!, code: String!, name: String!, kind: BranchKind!, phone: String, gstin: String, address: Address, active: Boolean! }

  type Patient {
    id: ID!
    uhid: String!
    title: String
    name: String!
    sex: Sex!
    dob: DateTime
    ageYears: Int
    phone: String
    email: String
    address: Address
    branch: Branch
    createdAt: DateTime!
    bookings(limit: Int = 20): [Booking!]!
    invoices(limit: Int = 20): [Invoice!]!
  }

  type Doctor { id: ID!, name: String!, qualification: String, phone: String, clinic: String, active: Boolean! }

  type BookingTest { testCode: String!, name: String!, pricePaise: Int!, sampleType: String }
  type SampleCollection { type: CollectionType!, scheduledAt: DateTime, address: Address }

  type Booking {
    id: ID!
    bookingNo: String!
    status: BookingStatus!
    patient: Patient!
    doctor: Doctor
    branch: Branch!
    tests: [BookingTest!]!
    sampleCollection: SampleCollection!
    samples: [Sample!]!
    reports: [Report!]!
    invoice: Invoice
    notes: String
    createdAt: DateTime!
  }

  type Sample {
    id: ID!
    barcode: String!
    sampleType: String!
    status: SampleStatus!
    collectedAt: DateTime
    receivedAt: DateTime
    rejectReason: String
  }

  type ResultValue { parameter: String!, value: String!, unit: String, flag: ResultFlag, range: String }

  type Report {
    id: ID!
    testCode: String!
    testName: String!
    status: ReportStatus!
    results: [ResultValue!]!
    version: Int!
    verifiedAt: DateTime
    releasedAt: DateTime
    patient: Patient!
    booking: Booking!
    updatedAt: DateTime!
  }

  type InvoiceItem {
    code: String
    name: String!
    category: ItemCategory!
    qty: Float!
    ratePaise: Int!
    discountPaise: Int!
    taxPercent: Float!
    amountPaise: Int!
  }

  type Invoice {
    id: ID!
    invoiceNo: String!
    status: InvoiceStatus!
    patient: Patient!
    branch: Branch!
    booking: Booking
    items: [InvoiceItem!]!
    subtotalPaise: Int!
    discountPaise: Int!
    taxPaise: Int!
    roundOffPaise: Int!
    totalPaise: Int!
    paidPaise: Int!
    duePaise: Int!
    issuedAt: DateTime
    cancelReason: String
    payments: [Payment!]!
    vouchers: [Voucher!]!
  }

  type Payment { id: ID!, kind: PaymentKind!, amountPaise: Int!, mode: PaymentMode!, reference: String, receivedAt: DateTime! }

  # ---------------------------------------------------------------- accounting (Tally-style)

  type AccountGroup { id: ID!, name: String!, nature: AccountNature!, parent: AccountGroup, affectsGrossProfit: Boolean! }

  type Ledger {
    id: ID!
    name: String!
    group: AccountGroup!
    openingPaise: Int!
    systemKey: String
    gstin: String
    active: Boolean!
    "Closing balance, positive = Debit."
    balancePaise(asOf: DateTime, branchId: ID): Int!
  }

  type VoucherEntry { ledger: Ledger!, debitPaise: Int!, creditPaise: Int!, invoiceId: ID }

  type Voucher {
    id: ID!
    type: VoucherType!
    voucherNo: String!
    date: DateTime!
    narration: String
    status: VoucherStatus!
    entries: [VoucherEntry!]!
    invoiceId: ID
  }

  type StatementRow { date: DateTime!, voucherNo: String!, voucherType: VoucherType!, debitPaise: Int!, creditPaise: Int!, balancePaise: Int!, invoiceId: ID }
  type LedgerStatement { ledger: Ledger!, openingPaise: Int!, closingPaise: Int!, totalDebitPaise: Int!, totalCreditPaise: Int!, rows: [StatementRow!]! }
  type TrialBalanceRow { ledger: Ledger!, group: AccountGroup!, primaryGroup: AccountGroup!, debitPaise: Int!, creditPaise: Int! }
  type TrialBalance { rows: [TrialBalanceRow!]!, totalDebitPaise: Int!, totalCreditPaise: Int!, differencePaise: Int! }
  type LedgerAmount { ledger: Ledger!, amountPaise: Int! }
  type GroupLine { group: AccountGroup!, amountPaise: Int!, ledgers: [LedgerAmount!]! }
  type ProfitAndLoss { income: [GroupLine!]!, expenses: [GroupLine!]!, grossProfitPaise: Int!, netProfitPaise: Int! }
  type BalanceSheet { assets: [GroupLine!]!, liabilities: [GroupLine!]!, profitPaise: Int!, totalAssetsPaise: Int!, totalLiabilitiesPaise: Int!, differencePaise: Int! }
  type OutstandingRow { invoice: Invoice!, ageDays: Int!, bucket: AgeBucket! }
  type BucketTotals { d0to30: Int!, d31to60: Int!, d61to90: Int!, d90plus: Int! }
  type Outstanding { rows: [OutstandingRow!]!, buckets: BucketTotals!, totalDuePaise: Int! }
  type GstSummary { taxableValuePaise: Int!, cgstPaise: Int!, sgstPaise: Int!, igstPaise: Int!, totalTaxPaise: Int! }

  type Query {
    organization: Organization!
    branches: [Branch!]!
    patient(id: ID!): Patient
    "Name, phone or UHID."
    patients(search: String!, limit: Int = 20): [Patient!]!
    doctors: [Doctor!]!
    booking(id: ID!): Booking
    bookings(branchId: ID, status: BookingStatus, patientId: ID, limit: Int = 50, offset: Int = 0): [Booking!]!
    sampleByBarcode(barcode: String!): Sample
    report(id: ID!): Report
    invoice(id: ID!): Invoice
    invoices(branchId: ID, status: InvoiceStatus, patientId: ID, limit: Int = 50, offset: Int = 0): [Invoice!]!

    accountGroups: [AccountGroup!]!
    ledgers: [Ledger!]!
    ledgerStatement(ledgerId: ID!, from: DateTime!, to: DateTime!, branchId: ID): LedgerStatement!
    trialBalance(asOf: DateTime, branchId: ID): TrialBalance!
    profitAndLoss(from: DateTime!, to: DateTime!, branchId: ID): ProfitAndLoss!
    balanceSheet(asOf: DateTime!, branchId: ID): BalanceSheet!
    dayBook(from: DateTime!, to: DateTime!, branchId: ID, type: VoucherType): [Voucher!]!
    outstandingReceivables(branchId: ID): Outstanding!
    gstSummary(from: DateTime!, to: DateTime!, branchId: ID): GstSummary!
  }

  input AddressInput { line1: String, line2: String, city: String, district: String, state: String, pincode: String }

  input RegisterPatientInput {
    branchId: ID!
    title: String
    name: String!
    sex: Sex!
    dob: DateTime
    ageYears: Int
    phone: String
    email: String
    address: AddressInput
  }

  input UpdatePatientInput { title: String, name: String, sex: Sex, dob: DateTime, ageYears: Int, phone: String, email: String, address: AddressInput }

  input DoctorInput { name: String!, qualification: String, phone: String, clinic: String, active: Boolean = true }

  input BookingTestInput { testCode: String!, name: String!, pricePaise: Int!, sampleType: String }

  input CreateBookingInput {
    branchId: ID!
    patientId: ID!
    doctorId: ID
    tests: [BookingTestInput!]!
    collectionType: CollectionType = walk_in
    scheduledAt: DateTime
    notes: String
  }

  input ResultInput { parameter: String!, value: String!, unit: String, flag: ResultFlag, range: String }

  input InvoiceItemInput { code: String, name: String!, category: ItemCategory = test, qty: Float = 1, ratePaise: Int!, discountPaise: Int = 0, taxPercent: Float = 0 }
  input PaymentInput { amountPaise: Int!, mode: PaymentMode!, reference: String }

  input IssueInvoiceInput {
    branchId: ID!
    patientId: ID!
    bookingId: ID
    items: [InvoiceItemInput!]!
    billDiscountPaise: Int = 0
    payments: [PaymentInput!]
  }

  input VoucherEntryInput { ledgerId: ID!, debitPaise: Int = 0, creditPaise: Int = 0, invoiceId: ID }
  input PostVoucherInput { branchId: ID!, type: VoucherType!, date: DateTime, narration: String, entries: [VoucherEntryInput!]! }
  input LedgerInput { name: String!, groupId: ID!, openingPaise: Int = 0, gstin: String }

  type CreateBookingResult { booking: Booking!, samples: [Sample!]! }

  type Mutation {
    registerPatient(input: RegisterPatientInput!): Patient!
    updatePatient(id: ID!, input: UpdatePatientInput!): Patient!
    createDoctor(input: DoctorInput!): Doctor!

    createBooking(input: CreateBookingInput!): CreateBookingResult!
    cancelBooking(id: ID!): Booking!
    collectSample(id: ID!): Sample!
    receiveSample(id: ID!): Sample!
    rejectSample(id: ID!, reason: String!): Sample!

    createReport(bookingId: ID!, testCode: String!, testName: String!): Report!
    saveResults(reportId: ID!, results: [ResultInput!]!): Report!
    verifyReport(id: ID!): Report!
    releaseReport(id: ID!): Report!
    amendReport(id: ID!): Report!

    issueInvoice(input: IssueInvoiceInput!): Invoice!
    recordPayment(invoiceId: ID!, payment: PaymentInput!): Invoice!
    refundPayment(invoiceId: ID!, payment: PaymentInput!): Invoice!
    cancelInvoice(id: ID!, reason: String!): Invoice!

    setupChartOfAccounts: [Ledger!]!
    createLedger(input: LedgerInput!): Ledger!
    postVoucher(input: PostVoucherInput!): Voucher!
    cancelVoucher(id: ID!): Voucher!
  }
`;
