# AGENTS.md — @mgpl-diagnostics/db-kit

The data layer for MGPL Diagnostics: one domain model on **MongoDB (Mongoose)** or **PostgreSQL
(Sequelize)** behind the same repository interface, Tally-style double-entry accounting, a Redis cache
toolkit, and Fastify / Express decorators.

> **Pending move:** `src/graphql/` belongs in the backend repo. Read
> [docs/MOVE-GRAPHQL-TO-BACKEND.md](docs/MOVE-GRAPHQL-TO-BACKEND.md) before touching GraphQL code.

## Map

```
src/core/       types, ports (repository interface + errors + PostingHook), services (workflows), money,
                numbering, accounting (groups, ledgers, vouchers, lock dates, auto-posting), reports
src/mongo/      Mongoose schemas + repositories (transactions need a replica set)
src/pg/         Sequelize models + repositories (row locks, retry on 40001/40P01)
src/cache/      cache-aside, single-flight, stampede lock, SWR, negative, tags, namespaces,
                two-tier L1+L2, rate limiters, distributed lock, cached repositories
src/adapters/   fastify (decorates app.db), express (attachDb, dbErrorHandler)
src/graphql/    TO BE MOVED (see the handoff doc)
scripts/test.ts one contract suite on real MongoDB + real PostgreSQL (in-process), plus cache and adapters
```

## Rules

1. **Both backends behave identically.** Change a repository → change it in `mongo/` and `pg/`, then
   `npm test` (the contract suite runs on both).
2. **Money is integer paise.** Every voucher balances (`assertBalanced`). Never post without `postVoucher`.
3. **Multi-record work runs in `repos.transaction()`.** Inside, use the `tx` repositories only.
4. **Sequelize attribute definitions must be fresh objects per column** (factories like `id()`,
   `money()`). Sequelize mutates them; a shared object made every money column write to `subtotal_paise`.
5. **MongoDB unique indexes count `null`.** Use `partialFilterExpression` for optional unique keys.
6. No passwords or auth logic here: users store a `passwordHash` produced by auth-kit.
7. Never commit patient data, credentials, or `.env` files.
8. **Lock dates are checked inside the posting transaction** (`assertPeriodOpen` in `postVoucher` /
   `cancelVoucher`). Never write vouchers or ledger entries around it.
9. **Billing posts through `repos.posting`** (a `PostingHook`, default `defaultPostingHook`). Set it with
   `createDb({ posting })`; finance-kit supplies one. Finance storage is described in
   [docs/FINANCE-STORAGE.md](docs/FINANCE-STORAGE.md); finance rules live in finance-kit, not here.
10. No dates inside JSON arrays (JSONB returns strings): use IST day strings like `"2026-10-14"`.

## Commands

```bash
npm run typecheck
npm test          # starts MongoDB (replica set) + PostgreSQL in-process; REDIS_URL optional
npm run build
```
