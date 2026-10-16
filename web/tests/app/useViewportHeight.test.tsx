import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewportHeight } from "../../src/useViewportHeight";

const INITIAL_HEIGHT = 768.4;
const RESIZED_HEIGHT = 420.6;
const FRAME_TIME = 16;
let viewport: EventTarget & { height: number };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function resize(height: number) {
  viewport.height = height;
  act(() => { viewport.dispatchEvent(new Event("resize")); });
}

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => { pending.forEach(callback => callback(FRAME_TIME)); });
}

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { height: INITIAL_HEIGHT });
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const frame = ++nextFrame;
    frames.set(frame, callback);
    return frame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((frame: number) => { frames.delete(frame); }));
});

afterEach(() => {
  cleanup();
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

  it("同一动画帧合并resize并读取最新高度，下一帧仍能更新", () => {
    const { result } = renderHook(useViewportHeight);
    resize(600);
    resize(RESIZED_HEIGHT);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(Math.round(INITIAL_HEIGHT));
    flushFrame();
    expect(result.current).toBe(Math.round(RESIZED_HEIGHT));
    resize(700);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    flushFrame();
    expect(result.current).toBe(700);
  });

  it.each([NaN, Infinity, -Infinity, 0, -10, 0.2])("忽略无效高度%s，后续有效高度仍可恢复", (height) => {
    viewport.height = height;
    const { result } = renderHook(useViewportHeight);
    expect(result.current).toBeUndefined();
    resize(RESIZED_HEIGHT);
    flushFrame();
    expect(result.current).toBe(Math.round(RESIZED_HEIGHT));
    resize(height);
    flushFrame();
    expect(result.current).toBe(Math.round(RESIZED_HEIGHT));
  });

  it("卸载移除resize监听并取消待执行帧，不再调度新帧", () => {
    const removeListener = vi.spyOn(viewport, "removeEventListener");
    const addListener = vi.spyOn(viewport, "addEventListener");
    const { unmount } = renderHook(useViewportHeight);
    const listener = addListener.mock.calls[0][1];
    resize(RESIZED_HEIGHT);
    const pendingFrame = [...frames.keys()][0];
    unmount();
    expect(removeListener).toHaveBeenCalledWith("resize", listener);
    expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(pendingFrame);
    expect(frames.size).toBe(0);
    resize(700);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("卸载时不取消已执行的动画帧", () => {
    const { unmount } = renderHook(useViewportHeight);
    resize(RESIZED_HEIGHT);
    flushFrame();
    unmount();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });
});
