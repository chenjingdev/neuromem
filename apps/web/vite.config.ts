import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const coreHeaders = env.CORE_API_TOKEN ? { Authorization: `Bearer ${env.CORE_API_TOKEN}` } : undefined;
  return {
    base: "./",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 4173,
      proxy: {
        "/core-api": {
          target: env.CORE_API_UPSTREAM || "http://127.0.0.1:18001",
          changeOrigin: true,
          rewrite: path => path.replace(/^\/core-api/, ""),
          headers: coreHeaders,
        },
      },
    },
    preview: { host: "127.0.0.1", port: 4173 },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: true,
    },
  };
});
