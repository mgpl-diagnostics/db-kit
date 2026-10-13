import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { createDb, type CreateDbOptions, type Db } from "../create-db";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

export interface FastifyDbOptions extends Partial<CreateDbOptions> {
  /** An already created Db (shared with workers or other plugins). Otherwise one is created from the options. */
  db?: Db;
}

/**
 * Fastify plugin: decorates `fastify.db` ({ repos, rawRepos, cache, redis }) and closes it on shutdown.
 * Errors from db-kit carry `statusCode` (404 not found, 409 conflict, 422 unbalanced voucher), which
 * Fastify uses for the response.
 *
 *   await app.register(mgplDb, { backend: "pg", pg: { url: process.env.DATABASE_URL }, redis: process.env.REDIS_URL });
 *   app.get("/patients/:id", (req) => app.db.repos.patients.get(req.params.id));
 */
const plugin: FastifyPluginAsync<FastifyDbOptions> = async (fastify: FastifyInstance, options) => {
  const owned = !options.db;
  const db = options.db ?? (await createDb(options as CreateDbOptions));
  fastify.decorate("db", db);
  if (owned) fastify.addHook("onClose", async () => db.close());
};

// visible to the whole app (same as fastify-plugin), not only to this plugin's children
(plugin as any)[Symbol.for("skip-override")] = true;
(plugin as any)[Symbol.for("fastify.display-name")] = "mgpl-db";

export const mgplDb = plugin;
export default plugin;
