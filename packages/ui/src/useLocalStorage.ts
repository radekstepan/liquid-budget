import { useState, useEffect, useCallback, useRef } from "react";

export function useLocalStorage<T>(
  key: string,
  initialValue: T | (() => T),
  validate?: (val: unknown) => boolean
): [T, (value: T | ((val: T) => T)) => void] {
  const initialValueRef = useRef(initialValue);
  initialValueRef.current = initialValue;
  const validateRef = useRef(validate);
  validateRef.current = validate;

  const readValue = useCallback((): T => {
    const fallback =
      initialValueRef.current instanceof Function
        ? initialValueRef.current()
        : initialValueRef.current;

    if (typeof window === "undefined") {
      return fallback;
    }
    try {
      const item = window.localStorage.getItem(key);
      if (item === null) {
        return fallback;
      }
      const parsed = JSON.parse(item);
      if (validateRef.current && !validateRef.current(parsed)) {
        // Invalid stored value: drop the entry and fall back silently (no
        // console output — Vitest onConsoleLog throws on any console call).
        try {
          window.localStorage.removeItem(key);
        } catch {}
        return fallback;
      }
      return parsed as T;
    } catch {
      // Corrupt stored value (or storage unavailable): drop the entry and
      // fall back silently (see above).
      try {
        window.localStorage.removeItem(key);
      } catch {}
      return fallback;
    }
  }, [key]);

  const [storedValue, setStoredValue] = useState<T>(readValue);
  const storedValueRef = useRef<T>(storedValue);
  storedValueRef.current = storedValue;

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      if (typeof window === "undefined") {
        return;
      }
      try {
        const valueToStore =
          value instanceof Function ? value(storedValueRef.current) : value;

        if (validateRef.current && !validateRef.current(valueToStore)) {
          // Refuse invalid values silently (no console output — Vitest
          // onConsoleLog throws on any console call).
          return;
        }

        storedValueRef.current = valueToStore;
        setStoredValue(valueToStore);

        try {
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch {
          // Storage full/unavailable: in-memory state already updated above;
          // the persisted copy is best-effort. Swallowed silently (see above).
        }
      } catch {
        // Serializing the value (or invoking an updater) threw: keep the
        // previous state. Swallowed silently (see above).
      }
    },
    [key]
  );

  useEffect(() => {
    const val = readValue();
    storedValueRef.current = val;
    setStoredValue(val);
  }, [key, readValue]);

  return [storedValue, setValue];
}

