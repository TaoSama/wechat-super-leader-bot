import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const controllerTarget =
  process.env.VITE_CONTROLLER_PROXY_TARGET || "http://127.0.0.1:8790";

export default defineConfig({
  envDir: process.env.SUPER_LEADER_NO_DOTENV === "1" ? false : undefined,
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/auth": {
        target: controllerTarget,
        changeOrigin: true,
      },
      "/v1": {
        target: controllerTarget,
        changeOrigin: true,
      },
      "/health": {
        target: controllerTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
