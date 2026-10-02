import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "../model/src/db/schema.ts",
  out: "./drizzle",
});
