# Handoff: move the GraphQL layer from db-kit to the backend repo

**Audience:** the AI agent (or developer) doing the move. Follow the checklist top to bottom.
**Status (2026-10-13):** not started. Everything below currently lives in db-kit and passes its tests
(`npm test`: 194 checks; 38 of them are the GraphQL suite).

## Why

db-kit is the **data layer** (models, transactions, Tally accounting, Redis cache). Its only consumer
is the backend. The **API surface** belongs to the backend: one GraphQL endpoint that combines
db-kit, auth-kit, catalog-kit, and report/invoice rendering, plus REST only where needed (PDF
downloads, static assets, health checks, payment webhooks). Keeping GraphQL in db-kit mixes the two
jobs and spreads the schema across packages.

## Target

A new backend repo (working name **`mgpl-diagnostics/api`**). It owns:
- the Yoga server, mounted in Fastify;
- the merged schema and the resolvers;
- the request context, built by auth-kit;
- DataLoader batching and error codes.

## What moves (source → destination in the backend repo)

| db-kit file | Move to | Notes |
| --- | --- | --- |
| `src/graphql/type-defs.ts` | `src/graphql/modules/data/type-defs.ts` | SDL for patients, bookings, samples, reports, invoices, payments, accounting |
| `src/graphql/resolvers.ts` | `src/graphql/modules/data/resolvers.ts` | Change imports from `../core/*` to `@mgpl-diagnostics/db-kit` |
| `src/graphql/context.ts` | `src/graphql/context.ts` | `DbGraphQLContext` becomes the backend's request context; filled by auth-kit (see below) |
| `src/graphql/loader.ts` | `src/graphql/loader.ts` | Per-request batch loader (no dependency) |
| `src/graphql/index.ts` | `src/graphql/schema.ts` | `createSchema(modules)`, `DB_PERMISSIONS`, module type |
| `scripts/graphql-suite.ts` | `test/graphql-data.test.ts` | Replace the fake `can`/`branchesFor` with auth-kit's real ones |

## What stays in db-kit (do not move)

- `src/core/*`: domain types, repository interface (`ports.ts`), workflows (`services.ts`), money,
  numbering, accounting (`accounting.ts`), reports (`reports.ts`).
- `src/mongo/*`, `src/pg/*`: both backends, including **`getMany(ids)`** on every repository (the
  backend's DataLoaders need it).
- `src/cache/*`: Redis cache toolkit.
- `src/adapters/fastify.ts`, `src/adapters/express.ts`: they only decorate `db`, not an API.
- Error classes in `ports.ts`: `NotFoundError` (404), `ConflictError` (409), `ValidationError` (400),
  and `UnbalancedVoucherError` (422, in `accounting.ts`). The backend maps them to GraphQL codes.

## Checklist: db-kit side

1. Delete `src/graphql/`.
2. In `scripts/test.ts`, remove `import { graphqlSuite } …` and both `await graphqlSuite(…)` calls.
   Delete `scripts/graphql-suite.ts`.
3. In `package.json`:
   - remove the `"./graphql"` export;
   - remove the `graphql` and `@graphql-tools/schema` peer deps and their `peerDependenciesMeta`;
   - remove the `graphql`, `@graphql-tools/schema` and `graphql-yoga` dev deps;
   - drop "a GraphQL module" from the description.
4. In `tsup.config.ts`, remove the `graphql` entry and the two `graphql` externals.
5. `npm install --no-package-lock && npm run typecheck && npm test`. Expect **96 passed, 0 failed**.

## Checklist: backend side

1. Add the deps:
   - `graphql@^16.14`
   - `graphql-yoga@^5.24`
   - `@graphql-tools/schema@^10`
   - `@mgpl-diagnostics/db-kit`
   - `@mgpl-diagnostics/auth-kit`
2. Copy the files in the table. Fix the imports, so that everything in `core` comes from
   `@mgpl-diagnostics/db-kit`. That covers the services, accounting, reports and errors.
3. Build the context per request from auth-kit (its internal API is designed for this):
   ```ts
   const yoga = createYoga({
     schema: createSchema([dataModule /*, authModule, catalogModule … */]),
     context: async ({ request }) => {
       const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
       const auth = await authKit.context(token);   // { viewer, can, branchesFor }
       return { repos: db.repos, ...auth };
     },
   });
   ```
   Use **`db.repos`** (cached reads), not `db.rawRepos`. Workflows open their own transactions on
   the raw repositories.
4. Mount Yoga in Fastify. REST routes live beside it, and only for:
   - PDF and other binary downloads;
   - assets;
   - `/health`;
   - payment webhooks.
5. Seed roles with auth-kit's `SYSTEM_ROLES` (`seedOrganization(repos, { …, roles: SYSTEM_ROLES })`).
   auth-kit's roles must grant every permission in `DB_PERMISSIONS`. In particular, `accounts:read`,
   `accounts:post` and `accounts:manage` are new and are not in the original role presets.
6. Port the GraphQL suite. It must still prove:
   - `UNAUTHENTICATED` without a viewer;
   - `FORBIDDEN` for a missing permission;
   - branch-limited staff see only their branches;
   - discounts need `invoice:discount`;
   - another organisation gets `NOT_FOUND` or `null`;
   - posting into another organisation's ledgers is refused;
   - `CONFLICT` on overpayment;
   - `BAD_USER_INPUT` for an unbalanced voucher or qty 0;
   - 10 invoices with patients load in **1** batched query.

## Rules the resolvers rely on (keep them)

- **Tenant isolation:** never take `orgId` from arguments. Use `viewer.orgId`, and pass every fetched
  entity through `own(ctx, entity)` (it returns null for another organisation's data).
- **Permissions are branch-aware:** `authorize(ctx, permission, entity.branchId)`. Lists use
  `branchScope()` / `branchesFor()`, so branch-limited roles only see their branches.
- **Error codes:** domain errors go through `toGraphQLError()`. Never pass `originalError`. Yoga masks
  any `GraphQLError` that wraps a non-GraphQL error as "Unexpected error" (this bug was hit and fixed).
- **Enum mapping:** a result flag `""` ⇄ `NONE`. Ageing buckets `"0-30"` ⇄ `D0_30` and so on.
- **Limits:** list `limit` is capped at 200.
- **Postgres ids are UUIDs.** Test fixtures must use valid UUIDs for user ids (they are written to
  `audit_log.user_id`).
- **ACID:**
  - Workflows run in `repos.transaction()`.
  - MongoDB needs a replica set; on a standalone server db-kit throws `TransactionsUnsupportedError`.
  - Postgres locks invoices with `SELECT … FOR UPDATE` and retries on deadlock or serialization failure.
