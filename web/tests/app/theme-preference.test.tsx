import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useThemePreference } from "../../src/features/settings/useThemePreference";

afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals(); });
it("恢复浏览器偏好，跟随系统变更，并保存手动选择", () => {
  let listener: (() => void) | undefined;
  const media = { matches: false, addEventListener: (_event: string, callback: () => void) => { listener = callback; }, removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => media);
  window.localStorage.setItem("super-leader:theme", "system");
  const { result, unmount } = renderHook(useThemePreference);
  expect(result.current.theme).toBe("light");
  act(() => { media.matches = true; listener?.(); });
  expect(result.current.theme).toBe("dark");
  act(() => result.current.setPreference("light"));
  expect(result.current.theme).toBe("light");
  expect(window.localStorage.getItem("super-leader:theme")).toBe("light");
  unmount();
  expect(media.removeEventListener).toHaveBeenCalled();
});
