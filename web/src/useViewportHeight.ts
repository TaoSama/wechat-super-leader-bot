import { useEffect, useState } from "react";

const VIEWPORT_UPDATE_DELAY_MS = 16;

// Mobile keyboards resize the visual viewport without always resizing 100dvh.
export function useViewportHeight(): number | undefined {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let timer: number | undefined;
    const update = () => {
      timer = undefined;
      const next = Math.round(viewport.height);
      if (Number.isFinite(next) && next > 0) setHeight(next);
    };
    const schedule = () => {
      // Viewport geometry must update even when the browser suspends painting.
      // A short timer still coalesces resize bursts without depending on RAF.
      if (timer === undefined) timer = window.setTimeout(update, VIEWPORT_UPDATE_DELAY_MS);
    };
    update();
    viewport.addEventListener("resize", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      window.removeEventListener("resize", schedule);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);
  return height;
}
