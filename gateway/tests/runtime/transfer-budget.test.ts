import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TRANSFER_TIMEOUT_MS, transferTimeoutMs } from "../../src/runtime/transfer-budget.js";

const MIB = 1024 * 1024;
test("local transfer allowance scales with trusted byte size and remains bounded", () => {
  assert.equal(transferTimeoutMs(32 * MIB, 15_000), 47_000);
  assert.equal(transferTimeoutMs(50 * MIB, 30_000), 80_000);
  assert.equal(transferTimeoutMs(512 * MIB, 30_000), 542_000);
  assert.equal(transferTimeoutMs(Number.MAX_SAFE_INTEGER, 30_000), MAX_TRANSFER_TIMEOUT_MS);
  for (const size of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => transferTimeoutMs(size, 15_000), /Invalid transfer budget/);
  }
});
