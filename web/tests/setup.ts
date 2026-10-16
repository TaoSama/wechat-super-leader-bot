import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

class MemoryWebStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: new MemoryWebStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: new MemoryWebStorage(),
    configurable: true,
    writable: true,
  });
}

// jsdom supplies the element but does not implement the native dialog lifecycle.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, writable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } },
  close: { configurable: true, writable: true, value: function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute("open");
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  } },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
