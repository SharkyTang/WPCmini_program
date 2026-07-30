import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: mode !== "production",
  },
  test: {
    environment: "jsdom",
    env: {
      VITE_DEMO_ACCOUNT: "admin@demo.local",
      VITE_DEMO_PASSWORD: "demo1234",
    },
    exclude: [...configDefaults.exclude, "e2e/**"],
    setupFiles: "./src/test/setup.ts",
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
  },
}));
