import type { Db } from "../create-db";

/**
 * Express / Connect helpers. No express import: works with any (req, res, next) framework.
 *
 *   const db = await createDb({ backend: "mongo", mongo: { uri }, redis: process.env.REDIS_URL });
 *   app.use(attachDb(db));
 *   app.get("/patients/:id", async (req, res, next) => res.json(await req.db.repos.patients.get(req.params.id)));
 *   app.use(dbErrorHandler());
 */

type Next = (err?: unknown) => void;

export interface DbRequest {
  db: Db;
}

export function attachDb(db: Db) {
  return (req: any, _res: unknown, next: Next) => {
    (req as DbRequest).db = db;
    next();
  };
}

/** Maps db-kit errors (statusCode 404 / 409 / 422) to JSON responses; passes others on. */
export function dbErrorHandler() {
  return (err: any, _req: unknown, res: any, next: Next) => {
    const status = err?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: err.message });
      return;
    }
    next(err);
  };
}
