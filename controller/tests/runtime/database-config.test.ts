import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/runtime/config.js";

const originalEnv = process.env;
const pgVariables = ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGPASSWORD"] as const;

beforeEach(() => {
  process.env = {
    SUPER_LEADER_NO_DOTENV: "1",
    CONTROLLER_TOKEN: "synthetic-controller-token",
    PGHOST: "synthetic-db.invalid",
    PGPORT: "5439",
    PGUSER: "synthetic-user",
    PGDATABASE: "synthetic-database",
    PGPASSWORD: "synthetic#/%:@?$ password",
  };
});
afterEach(() => { process.env = originalEnv; });

describe("PostgreSQL connection configuration", () => {
  it.each(["synthetic#password", "synthetic/password", " synthetic#/%:@?$ password "])(
    "keeps a raw password intact through pg environment parsing (%s)", (password) => {
      process.env.PGPASSWORD = password;
      process.env.DATABASE_URL = "";
      const config = loadConfig();
      expect(config.databaseUrl).toBeUndefined();
      const client = new pg.Client({ connectionString: config.databaseUrl });
      expect(client.host).toBe(process.env.PGHOST);
      expect(client.port).toBe(5439);
      expect(client.user).toBe(process.env.PGUSER);
      expect(client.database).toBe(process.env.PGDATABASE);
      expect(client.password).toBe(password);
    },
  );

  it.each(pgVariables)("fails closed with redacted diagnostics when %s is missing", (name) => {
    delete process.env[name];
    expect(() => loadConfig()).toThrow(/DATABASE_URL.*required/);
    try {
      loadConfig();
    } catch (error) {
      expect(String(error)).not.toContain("synthetic#/%:@?$ password");
    }
  });

  it.each(["0", "65536", "5432suffix"])("rejects an invalid PGPORT (%s)", (port) => {
    process.env.PGPORT = port;
    expect(() => loadConfig()).toThrow(/Invalid PGPORT/);
  });

  it("keeps an explicit DATABASE_URL authoritative over PG environment values", () => {
    const password = "synthetic#/%:@?$ password";
    process.env.DATABASE_URL = `postgresql://uri-user:${encodeURIComponent(password)}@uri-db.invalid:5544/uri-database`;
    process.env.PGPORT = "invalid-unused-port";
    const config = loadConfig();
    const client = new pg.Client({ connectionString: config.databaseUrl });
    expect(config.databaseUrl).toBe(process.env.DATABASE_URL);
    expect(client.host).toBe("uri-db.invalid");
    expect(client.port).toBe(5544);
    expect(client.user).toBe("uri-user");
    expect(client.database).toBe("uri-database");
    expect(client.password).toBe(password);
  });
});
