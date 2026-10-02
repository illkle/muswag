import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "../shared/src/db/schema.ts",
  out: "./drizzle",
});
