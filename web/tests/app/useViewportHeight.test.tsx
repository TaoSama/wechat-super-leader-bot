import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewportHeight } from "../../src/useViewportHeight";

const INITIAL_HEIGHT = 768.4;
const RESIZED_HEIGHT = 420.6;
const UPDATE_DELAY_MS = 16;
let viewport: EventTarget & { height: number };

function resize(height: number) {
  viewport.height = height;
  act(() => { viewport.dispatchEvent(new Event("resize")); });
}

function flushUpdate() {
  act(() => { vi.advanceTimersByTime(UPDATE_DELAY_MS); });
}

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { height: INITIAL_HEIGHT });
  vi.useFakeTimers();
  vi.stubGlobal("visualViewport", viewport);
  // Deliberately never paint: viewport sizing must not wait for this callback.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useViewportHeight", () => {
  it("读取并四舍五入初始可视高度，不等待动画帧", () => {
    const { result } = renderHook(useViewportHeight);
    expect(result.current).toBe(Math.round(INITIAL_HEIGHT));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("没有visualViewport时保留未定义高度且不订阅resize", () => {
    vi.stubGlobal("visualViewport", undefined);
    const addListener = vi.spyOn(window, "addEventListener");
    const { result, unmount } = renderHook(useViewportHeight);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(result.current).toBeUndefined();
    expect(addListener).not.toHaveBeenCalledWith("resize", expect.any(Function));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    unmount();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("短timer合并resize并读取最新高度，无绘制帧仍能持续更新", () => {
    const { result } = renderHook(useViewportHeight);
    resize(600);
    resize(RESIZED_HEIGHT);
    expect(vi.getTimerCount()).toBe(1);
    expect(result.current).toBe(Math.round(INITIAL_HEIGHT));
    flushUpdate();
    expect(result.current).toBe(Math.round(RESIZED_HEIGHT));
    resize(700);
    expect(vi.getTimerCount()).toBe(1);
    flushUpdate();
    expect(result.current).toBe(700);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("横屏切换及键盘开关跟随visualViewport高度，不依赖RAF或改变后的innerHeight", () => {
    const { result } = renderHook(useViewportHeight);
    resize(375);
    flushUpdate();
    expect(result.current).toBe(375);
    resize(210.4);
    flushUpdate();
    expect(result.current).toBe(210);
    resize(375);
    flushUpdate();
    expect(result.current).toBe(375);
    resize(812);
    flushUpdate();
    expect(result.current).toBe(812);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("window先发resize时也读取可视高度，与viewport事件共享同一个timer", () => {
    const { result } = renderHook(useViewportHeight);
    viewport.height = 375;
    act(() => { window.dispatchEvent(new Event("resize")); });
    resize(360);
    expect(vi.getTimerCount()).toBe(1);
    flushUpdate();
    expect(result.current).toBe(360);
  });

  it.each([NaN, Infinity, -Infinity, 0, -10, 0.2])("忽略无效高度%s，后续有效高度仍可恢复", (height) => {
    viewport.height = height;
    const { result } = renderHook(useViewportHeight);
    expect(result.current).toBeUndefined();
    resize(RESIZED_HEIGHT);
    flushUpdate();
    expect(result.current).toBe(Math.round(RESIZED_HEIGHT));
    resize(height);
    flushUpdate();
    expect(result.current).toBe(Math.round(RESIZED_HEIGHT));
  });

  it("卸载移除两个resize监听并取消待执行timer，不再调度更新", () => {
    const removeListener = vi.spyOn(viewport, "removeEventListener");
    const addListener = vi.spyOn(viewport, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const clearTimer = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderHook(useViewportHeight);
    const listener = addListener.mock.calls[0][1];
    resize(RESIZED_HEIGHT);
    unmount();
    expect(removeListener).toHaveBeenCalledWith("resize", listener);
    expect(removeWindowListener).toHaveBeenCalledWith("resize", listener);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    resize(700);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(vi.getTimerCount()).toBe(0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("卸载时不取消已执行的timer", () => {
    const clearTimer = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderHook(useViewportHeight);
    resize(RESIZED_HEIGHT);
    flushUpdate();
    unmount();
    expect(clearTimer).not.toHaveBeenCalled();
  });
});
