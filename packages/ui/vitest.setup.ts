import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

beforeEach(() => {
  try {
    window.localStorage?.clear();
    window.history.replaceState(null, "", "/");
  } catch {}
});

