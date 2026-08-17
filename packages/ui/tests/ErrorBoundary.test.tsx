import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React, { useState } from "react";
import { ErrorBoundary } from "../src/ErrorBoundary.js";

function ThrowingComponent({ shouldThrow, message = "Crashed!" }: { shouldThrow: boolean; message?: string }) {
  if (shouldThrow) {
    throw new Error(message);
  }
  return <div>Component Works Properly</div>;
}

describe("ErrorBoundary", () => {
  // Suppress console.error in tests because React logs caught boundary errors
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalError;
  });

  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary name="Test View">
        <ThrowingComponent shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Component Works Properly")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary-fallback")).not.toBeInTheDocument();
  });

  it("renders fallback UI when child component throws", () => {
    render(
      <ErrorBoundary name="Budget View">
        <ThrowingComponent shouldThrow={true} message="Out of bounds error" />
      </ErrorBoundary>
    );

    expect(screen.getByTestId("error-boundary-fallback")).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong in Budget View/i)).toBeInTheDocument();
    expect(screen.getByText("Out of bounds error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("supports custom fallback node", () => {
    render(
      <ErrorBoundary fallback={<div>Custom Error Screen</div>}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Custom Error Screen")).toBeInTheDocument();
  });

  it("supports custom fallback render function with reset callback", () => {
    function ResettableContainer() {
      const [explode, setExplode] = useState(true);
      return (
        <ErrorBoundary
          fallback={(err, reset) => (
            <div>
              <span>Custom: {err.message}</span>
              <button onClick={() => { setExplode(false); reset(); }}>Recover</button>
            </div>
          )}
        >
          <ThrowingComponent shouldThrow={explode} message="Boom" />
        </ErrorBoundary>
      );
    }

    render(<ResettableContainer />);
    expect(screen.getByText("Custom: Boom")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /recover/i }));
    expect(screen.getByText("Component Works Properly")).toBeInTheDocument();
  });

  it("resets error state when Try Again is clicked", () => {
    function Parent() {
      const [crash, setCrash] = useState(true);
      return (
        <ErrorBoundary onReset={() => setCrash(false)}>
          <ThrowingComponent shouldThrow={crash} message="Flaky error" />
        </ErrorBoundary>
      );
    }

    render(<Parent />);
    expect(screen.getByText("Flaky error")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("Component Works Properly")).toBeInTheDocument();
  });
});
