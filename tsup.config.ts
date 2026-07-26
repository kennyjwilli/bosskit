import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    drizzle: "src/adapters/drizzle.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  treeshake: true,
  external: ["pg-boss", "zod"],
});
