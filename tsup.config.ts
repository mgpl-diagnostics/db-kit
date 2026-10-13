import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    mongo: "src/mongo/index.ts",
    pg: "src/pg/index.ts",
    cache: "src/cache/index.ts",
    fastify: "src/adapters/fastify.ts",
    express: "src/adapters/express.ts",
    graphql: "src/graphql/index.ts",
  },
  format: ["esm"],
  dts: true,
  target: "node20",
  platform: "node",
  clean: true,
  external: [/^node:/, "mongoose", "sequelize", "pg", "pg-hstore", "ioredis", "fastify", "graphql", "@graphql-tools/schema"],
});
