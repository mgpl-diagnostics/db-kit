import { GraphQLError } from "graphql";
import { ConflictError, NotFoundError, ValidationError, type Repositories } from "../core/ports";
import type { Branch, Doctor, Id, Invoice, Ledger, Patient, AccountGroup, Booking, RoleAssignment } from "../core/types";
import { BatchLoader } from "./loader";

/** The signed-in user, as resolved by auth-kit (or your own auth). */
export interface Viewer {
  userId: Id;
  orgId: Id;
  roles: RoleAssignment[];
}

/**
 * What the db-kit resolvers need from a request. auth-kit's context builder provides all of it;
 * any other auth can too.
 */
export interface DbGraphQLContext {
  repos: Repositories;
  viewer: Viewer | null;
  /** Throws (or returns false) when the viewer lacks `permission` in `branchId` (or anywhere when omitted). */
  can(permission: string, branchId?: Id | null): boolean | Promise<boolean>;
  /** Branches where the viewer has `permission`: "all" for organisation-wide roles. */
  branchesFor(permission: string): "all" | Id[] | Promise<"all" | Id[]>;
  /** Created on first use, one set per request. */
  loaders?: Loaders;
}

export interface Loaders {
  patient: BatchLoader<Patient>;
  branch: BatchLoader<Branch>;
  doctor: BatchLoader<Doctor>;
  booking: BatchLoader<Booking>;
  invoice: BatchLoader<Invoice>;
  ledger: BatchLoader<Ledger>;
  group: BatchLoader<AccountGroup>;
}

export function loaders(ctx: DbGraphQLContext): Loaders {
  const r = ctx.repos;
  return (ctx.loaders ??= {
    patient: new BatchLoader((ids) => r.patients.getMany(ids)),
    branch: new BatchLoader((ids) => r.branches.getMany(ids)),
    doctor: new BatchLoader((ids) => r.doctors.getMany(ids)),
    booking: new BatchLoader((ids) => r.bookings.getMany(ids)),
    invoice: new BatchLoader((ids) => r.invoices.getMany(ids)),
    ledger: new BatchLoader((ids) => r.ledgers.getMany(ids)),
    group: new BatchLoader((ids) => r.accountGroups.getMany(ids)),
  });
}

// ------------------------------------------------------------------ guards

export function viewerOf(ctx: DbGraphQLContext): Viewer {
  if (!ctx.viewer) throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHENTICATED", http: { status: 401 } } });
  return ctx.viewer;
}

export async function authorize(ctx: DbGraphQLContext, permission: string, branchId?: Id | null): Promise<Viewer> {
  const v = viewerOf(ctx);
  if (!(await ctx.can(permission, branchId))) {
    throw new GraphQLError(`Missing permission ${permission}`, { extensions: { code: "FORBIDDEN", permission, http: { status: 403 } } });
  }
  return v;
}

/** Null unless the entity belongs to the viewer's organisation (tenant isolation). */
export function own<T extends { orgId: Id }>(ctx: DbGraphQLContext, entity: T | null | undefined): T | null {
  return entity && ctx.viewer && entity.orgId === ctx.viewer.orgId ? entity : null;
}

/** Loads an entity by id, enforces organisation + permission in its branch; NOT_FOUND otherwise. */
export async function load<T extends { orgId: Id; branchId?: Id }>(
  ctx: DbGraphQLContext,
  name: string,
  fetch: () => Promise<T | null>,
  permission: string,
): Promise<T> {
  viewerOf(ctx);
  const e = own(ctx, await fetch());
  if (!e) throw notFound(name);
  await authorize(ctx, permission, e.branchId ?? null);
  return e;
}

export const notFound = (name: string) => new GraphQLError(`${name} not found`, { extensions: { code: "NOT_FOUND", http: { status: 404 } } });

/** The branch filter for a list: the requested one (checked) or the viewer's allowed branches. */
export async function branchScope(ctx: DbGraphQLContext, permission: string, branchId?: Id | null): Promise<"all" | Id[]> {
  if (branchId) {
    await authorize(ctx, permission, branchId);
    return [branchId];
  }
  viewerOf(ctx);
  const allowed = await ctx.branchesFor(permission);
  if (allowed !== "all" && !allowed.length) await authorize(ctx, permission); // throws FORBIDDEN
  return allowed;
}

/** Domain errors → GraphQL errors with codes. Anything else is re-thrown (and masked by the server). */
export function toGraphQLError(e: unknown): unknown {
  if (e instanceof GraphQLError) return e;
  const code =
    e instanceof NotFoundError ? "NOT_FOUND"
    : e instanceof ConflictError ? "CONFLICT"
    : e instanceof ValidationError ? "BAD_USER_INPUT"
    : null;
  if (!code) return e;
  const err = e as Error & { statusCode?: number };
  // no `originalError`: Yoga masks any GraphQLError that wraps a non-GraphQL error as "Unexpected error"
  return new GraphQLError(err.message, { extensions: { code, http: { status: err.statusCode } } });
}

/** Wraps every resolver of a map so domain errors surface with proper codes. */
export function withErrorCodes<R extends Record<string, Record<string, unknown>>>(resolvers: R): R {
  for (const type of Object.values(resolvers)) {
    for (const [field, fn] of Object.entries(type)) {
      if (typeof fn !== "function") continue;
      type[field] = async (...args: unknown[]) => {
        try {
          return await (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          throw toGraphQLError(e);
        }
      };
    }
  }
  return resolvers;
}
