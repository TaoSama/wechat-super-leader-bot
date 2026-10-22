import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { ModelObservationControl } from "../../src/features/sessions/components/ModelObservationControl";

it("模型控件完整展示只读来源和观测时间，关闭后回到原控件", () => {
  render(<ModelObservationControl model={{ model: "gpt-6.1-sol", modelProvider: "openai", reasoningEffort: "high", source: "control-socket", observedAt: "2026-10-22T10:00:00Z" }} />);
  const trigger = screen.getByRole("button", { name: "查看模型信息" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "模型信息" });
  expect(within(dialog).getByText("gpt-6.1-sol")).toBeVisible();
  expect(within(dialog).getByText("openai")).toBeVisible();
  expect(within(dialog).getByText("high")).toBeVisible();
  expect(within(dialog).getByText("控制接口记录")).toBeVisible();
  expect(within(dialog).getByText("2026-10-22 18:00:00")).toBeVisible();
  expect(within(dialog).getByText(/只读展示/)).toBeVisible();
  expect(within(dialog).queryByRole("combobox")).toBeNull();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
});
