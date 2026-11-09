"use client";

import { useEffect, useState } from "react";

// True when the OS asks for reduced motion: the spotlight cross-fade
// drops to zero duration (instant, like the pre-transition behavior) and
// hover stays fully functional — brightness-only either way, never
// scale/lift/bounce. Reads the media query in an effect (never during
// render) so server and hydration renders always agree.
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
