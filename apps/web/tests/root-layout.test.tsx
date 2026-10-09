import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement } from "react";
import RootLayout from "../src/app/layout";

describe("RootLayout", () => {
  it("suppresses hydration warnings on <html> for the theme pre-paint script", () => {
    // The synchronous theme script sets data-theme on <html> before React
    // hydrates, so the client attribute intentionally differs from the
    // server HTML. Without suppressHydrationWarning this logs a hydration
    // mismatch error on every load with a non-default theme.
    const el = RootLayout({ children: "x" }) as ReactElement<{
      suppressHydrationWarning?: boolean;
    }>;
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe("html");
    expect(el.props.suppressHydrationWarning).toBe(true);
  });
});
