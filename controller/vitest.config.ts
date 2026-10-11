import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: process.env.SUPER_LEADER_NO_DOTENV === "1" ? false : undefined,
});
