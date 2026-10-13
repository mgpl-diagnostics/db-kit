import { makeExecutableSchema } from "@graphql-tools/schema";
import type { GraphQLSchema } from "graphql";
import { resolvers } from "./resolvers";
import { typeDefs } from "./type-defs";

export { typeDefs, resolvers };
export { BatchLoader } from "./loader";
export {
  authorize, branchScope, load, loaders, own, toGraphQLError, viewerOf, withErrorCodes,
  type DbGraphQLContext, type Loaders, type Viewer,
} from "./context";

/** A GraphQL module: merge several (db-kit, auth-kit, catalog-kit, your own) into one schema. */
export interface GraphQLModule {
  typeDefs: string;
  resolvers: Record<string, any>;
}

export const dbModule: GraphQLModule = { typeDefs, resolvers };

/** Permissions the db-kit resolvers check. auth-kit's roles grant these. */
export const DB_PERMISSIONS = [
  "org:read", "branch:read",
  "patient:read", "patient:create", "patient:update",
  "doctor:read", "doctor:manage",
  "booking:read", "booking:create", "booking:cancel",
  "sample:read", "sample:collect", "sample:receive", "sample:reject",
  "report:read", "report:enter", "report:verify", "report:release", "report:amend",
  "invoice:read", "invoice:create", "invoice:discount", "invoice:cancel",
  "payment:create", "payment:refund",
  "accounts:read", "accounts:post", "accounts:manage",
] as const;

/**
 * Builds one executable schema from modules. Each module may `extend type Query/Mutation`.
 *   const schema = createSchema([dbModule, authModule, catalogModule]);
 *   const yoga = createYoga({ schema, context: (req) => auth.context(req, db.repos) });
 */
export function createSchema(modules: GraphQLModule[]): GraphQLSchema {
  return makeExecutableSchema({ typeDefs: modules.map((m) => m.typeDefs), resolvers: modules.map((m) => m.resolvers) });
}
