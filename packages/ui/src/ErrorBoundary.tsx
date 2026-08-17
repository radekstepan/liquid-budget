"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { Notice } from "@ynab/theme";
import { Btn } from "./ui.js";

export interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.name ?? "View"}]`, error, errorInfo);
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback(this.state.error, this.reset);
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          data-testid="error-boundary-fallback"
          className="p-6 m-4 max-w-xl mx-auto rounded border"
          style={{ borderColor: "var(--y-border)", background: "var(--y-canvas)" }}
        >
          <Notice tone="danger" title={`Something went wrong in ${this.props.name ?? "this component"}`}>
            <p className="text-[12px] my-2" style={{ color: "var(--y-ink)" }}>
              {this.state.error.message || "An unexpected rendering error occurred."}
            </p>
          </Notice>
          <div className="mt-4 flex gap-2">
            <Btn variant="primary" onClick={this.reset}>
              Try Again
            </Btn>
            <Btn onClick={() => typeof window !== "undefined" && window.location.reload()}>
              Reload Page
            </Btn>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
