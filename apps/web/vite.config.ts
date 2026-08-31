import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    base: "./",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 4173,
      proxy: {
        "/api": {
          target: env.CONTROL_API_UPSTREAM || "http://127.0.0.1:18080",
          changeOrigin: true,
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
