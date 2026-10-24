import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsSection } from "../../src/features/notifications/AutomationsSection";
import { getAuthSessionSnapshot, resetAuthHelperForTesting, setUnauthenticatedSession } from "../../src/auth/bootstrap";
import type { ConsoleAutomation } from "../../src/features/notifications/automation-contract";

const schedule: ConsoleAutomation = {
  id: "schedule-1", chatId: "chat-1", title: "每天研究更新", kind: "session", status: "active",
  timing: { type: "cron", expression: "0 9 * * *" }, timezone: "Asia/Shanghai", nextAt: Date.now() + 86_400_000,
};

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  resetAuthHelperForTesting();
  setUnauthenticatedSession("none");
});

afterEach(() => {
  cleanup();
  resetAuthHelperForTesting();
  vi.unstubAllGlobals();
});

describe("component auth generation isolation", () => {
  it("does not expire a renewed session when an older automation request returns 401", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    render(<AutomationsSection items={[schedule]} />);

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    const requestGeneration = getAuthSessionSnapshot().generation;
    setUnauthenticatedSession("none");
    expect(getAuthSessionSnapshot().generation).toBeGreaterThan(requestGeneration);

    pending.resolve(new Response("{}", { status: 401 }));
    await screen.findByRole("button", { name: "暂停" });
    expect(getAuthSessionSnapshot().state).toEqual({ status: "unauthenticated", reason: "none" });
    expect(screen.queryByText("会话登录已失效，请重新获取微信登录链接")).toBeNull();
  });
});
