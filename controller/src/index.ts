import { loadConfig } from "./runtime/config.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import { ControllerServer } from "./http/server.js";

async function main() {
  try {
    const config = loadConfig();
    console.log(`Starting Super Leader Controller (Persistence: ${config.persistenceMode})...`);

    const store =
      config.persistenceMode === "postgres"
        ? new PostgresStore(config.databaseUrl!)
        : new MemoryStore();

    const server = new ControllerServer(config, store);
    await server.start();

    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      await server.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("Fatal startup error:", err);
    process.exit(1);
  }
}

main();
