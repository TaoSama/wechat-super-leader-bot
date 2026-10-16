import { useEffect, useState } from "react";

// Mobile keyboards resize the visual viewport without always resizing 100dvh.
export function useViewportHeight(): number | undefined {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const next = Math.round(viewport.height);
      if (Number.isFinite(next) && next > 0) setHeight(next);
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);
  return height;
}
