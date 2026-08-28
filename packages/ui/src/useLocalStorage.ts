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
        console.warn(`Invalid value for localStorage key "${key}", removing stored entry`);
        try {
          window.localStorage.removeItem(key);
        } catch {}
        return fallback;
      }
      return parsed as T;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      try {
        window.localStorage.removeItem(key);
      } catch {}
      return fallback;
    }
  }, [key]);

  const [storedValue, setStoredValue] = useState<T>(readValue);

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      if (typeof window === "undefined") {
        return;
      }
      try {
        setStoredValue((prev) => {
          const valueToStore = value instanceof Function ? value(prev) : value;
          if (validateRef.current && !validateRef.current(valueToStore)) {
            console.warn(`Attempted to set invalid value for localStorage key "${key}"`);
            return prev;
          }
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
          return valueToStore;
        });
      } catch (error) {
        console.warn(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key]
  );

  useEffect(() => {
    setStoredValue(readValue());
  }, [key, readValue]);

  return [storedValue, setValue];
}

