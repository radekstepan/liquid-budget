"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createToast, type ToastItem } from "@ynab/theme";
import type { ToastFn } from "./types";

/** Auto-dismissing toast stack state for the budget shell. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const addToast: ToastFn = useCallback((message, tone = "info", opts) => {
    const t = createToast(message, tone, opts?.action);
    setToasts((prev) => [...prev, t]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== t.id));
      toastTimers.current.delete(t.id);
    }, opts?.durationMs ?? 4000);
    toastTimers.current.set(t.id, timer);
    return t;
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}
