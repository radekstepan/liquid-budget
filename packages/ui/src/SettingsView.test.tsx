"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView.js";
import type { SuggestBatchResult } from "./SettingsView.js";

const noop = async () => {};

describe("SettingsView AI suggestions", () => {
  it("hides the AI button when no status is provided", () => {
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
      />
    );
    expect(screen.queryByRole("button", { name: /suggest rename rules with ai/i })).toBeNull();
  });

  it("hides the AI button when the LLM is not configured", () => {
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
        suggestStatus={{ enabled: false, candidates: [], totalUnique: 0, truncated: false }}
        onSuggestRules={async () => ({ suggestions: [], skipped: [], model: "m", processed: 0 })}
      />
    );
    expect(screen.queryByRole("button", { name: /suggest rename rules with ai/i })).toBeNull();
  });

  it("shows the uncovered count and disables the button when everything is covered", () => {
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
        suggestStatus={{ enabled: true, candidates: [], totalUnique: 0, truncated: false }}
        onSuggestRules={async () => ({ suggestions: [], skipped: [], model: "m", processed: 0 })}
      />
    );
    const btn = screen.getByRole("button", { name: /suggest rename rules with ai/i });
    expect(btn).toHaveTextContent("Suggest with AI");
    expect(btn).toBeDisabled();
  });

  it("reviews suggestions and creates only the selected rules", async () => {
    const onSuggestRules = vi.fn(async () => ({
      suggestions: [
        { sourcePattern: "AMZN*123", targetPayee: "Amazon", count: 2 },
        { sourcePattern: "BCF1", targetPayee: "BC Ferries", count: 1 },
      ],
      skipped: [{ source: "Clean Cafe", reason: "Already clean — no rename needed." }],
      model: "test-model",
      processed: 2,
    }));
    const onAcceptSuggestions = vi.fn(async () => ({
      updated: 3,
      skippedLocked: 0,
      generalised: false,
    }));
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
        suggestStatus={{
          enabled: true,
          candidates: [{ payee: "AMZN*123", count: 2 }],
          totalUnique: 2,
          truncated: false,
        }}
        onSuggestRules={onSuggestRules}
        onAcceptSuggestions={onAcceptSuggestions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /suggest rename rules with ai/i }));
    await waitFor(() => expect(onSuggestRules).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("AMZN*123")).not.toBeNull());

    // Edit one target inline, uncheck the other row.
    fireEvent.change(screen.getByLabelText("Suggested name for AMZN*123"), {
      target: { value: "Amazon Prime" },
    });
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3); // two rows + apply-to-existing
    fireEvent.click(boxes[1]!);

    fireEvent.click(screen.getByRole("button", { name: /create 1 rule/i }));
    await waitFor(() => expect(onAcceptSuggestions).toHaveBeenCalledTimes(1));
    expect(onAcceptSuggestions).toHaveBeenCalledWith(
      [{ sourcePattern: "AMZN*123", targetPayee: "Amazon Prime" }],
      true
    );
    await waitFor(() => expect(screen.getByText("AI rules created")).not.toBeNull());
  });

  it("shows the memos the AI saw under each suggestion that had any", async () => {
    const onSuggestRules = vi.fn(async () => ({
      suggestions: [
        {
          sourcePattern: "PAYPAL *4821",
          targetPayee: "Spotify",
          count: 2,
          memos: ["Spotify Premium", "order #42"],
        },
        { sourcePattern: "BCF1", targetPayee: "BC Ferries", count: 1 },
      ],
      skipped: [],
      model: "test-model",
      processed: 2,
    }));
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
        suggestStatus={{
          enabled: true,
          candidates: [{ payee: "PAYPAL *4821", count: 2 }],
          totalUnique: 2,
          truncated: false,
        }}
        onSuggestRules={onSuggestRules}
        onAcceptSuggestions={async () => ({ updated: 0, skippedLocked: 0, generalised: false })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /suggest rename rules with ai/i }));
    await waitFor(() => expect(screen.getByText("PAYPAL *4821")).not.toBeNull());
    expect(screen.getByText(/Spotify Premium/)).toBeInTheDocument();
    expect(screen.getByText(/order #42/)).toBeInTheDocument();
    // The memo-less row shows no memo line.
    expect(screen.getAllByText(/Memos:/)).toHaveLength(1);
  });

  it("shows suggest errors inline instead of opening the modal", async () => {
    const onSuggestRules = vi.fn(async () => {
      throw new Error("The AI service returned an error (HTTP 500).");
    });
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
        suggestStatus={{
          enabled: true,
          candidates: [{ payee: "AMZN*123", count: 1 }],
          totalUnique: 1,
          truncated: false,
        }}
        onSuggestRules={onSuggestRules}
        onAcceptSuggestions={async () => ({ updated: 0, skippedLocked: 0, generalised: false })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /suggest rename rules with ai/i }));
    await waitFor(() => expect(onSuggestRules).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText("The AI service returned an error (HTTP 500).")).not.toBeNull()
    );
    expect(screen.getByText("AI suggestions failed")).not.toBeNull();
    expect(screen.queryByText(/AI suggestions —/)).toBeNull();
  });

  it("walks the queue in batches of 10 with % progress", async () => {
    const releases: Array<() => void> = [];
    const onSuggestRules = vi.fn(
      (offset: number) =>
        new Promise<SuggestBatchResult>((resolve) => {
          releases.push(() =>
            resolve({
              suggestions: [
                {
                  sourcePattern: `PAYEE ${offset}`,
                  targetPayee: `Payee ${offset}`,
                  count: 1,
                },
              ],
              skipped: [],
              model: "test-model",
              processed: offset === 20 ? 5 : 10,
            })
          );
        })
    );
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
        suggestStatus={{ enabled: true, candidates: [], totalUnique: 25, truncated: false }}
        onSuggestRules={onSuggestRules}
        onAcceptSuggestions={async () => ({ updated: 0, skippedLocked: 0, generalised: false })}
      />
    );
    const btn = screen.getByRole("button", { name: /suggest rename rules with ai/i });
    fireEvent.click(btn);

    await waitFor(() => expect(onSuggestRules).toHaveBeenCalledWith(0, 10));
    await waitFor(() => expect(btn).toHaveTextContent("Thinking…"));
    releases[0]!();
    await waitFor(() => expect(onSuggestRules).toHaveBeenCalledWith(10, 10));
    await waitFor(() => expect(btn).toHaveTextContent("Thinking… 40%"));
    releases[1]!();
    await waitFor(() => expect(onSuggestRules).toHaveBeenCalledWith(20, 10));
    await waitFor(() => expect(btn).toHaveTextContent("Thinking… 80%"));
    releases[2]!();

    await waitFor(() => expect(screen.getByText("PAYEE 0")).not.toBeNull());
    expect(screen.getByText("PAYEE 10")).not.toBeNull();
    expect(screen.getByText("PAYEE 20")).not.toBeNull();
    expect(onSuggestRules).toHaveBeenCalledTimes(3);
  });

  it("keeps successful batches when one batch fails", async () => {
    const onSuggestRules = vi.fn(async (offset: number) => {
      if (offset === 10) throw new Error("boom");
      return {
        suggestions: [
          { sourcePattern: `PAYEE ${offset}`, targetPayee: `Payee ${offset}`, count: 1 },
        ],
        skipped: [],
        model: "test-model",
        processed: 10,
      };
    });
    render(
      <SettingsView
        rules={[]}
        onAdd={noop}
        onUpdate={noop}
        onDelete={noop}
        suggestStatus={{ enabled: true, candidates: [], totalUnique: 25, truncated: false }}
        onSuggestRules={onSuggestRules}
        onAcceptSuggestions={async () => ({ updated: 0, skippedLocked: 0, generalised: false })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /suggest rename rules with ai/i }));

    await waitFor(() => expect(screen.getByText("PAYEE 0")).not.toBeNull());
    expect(screen.getByText("PAYEE 20")).not.toBeNull();
    expect(screen.queryByText("PAYEE 10")).toBeNull();
    expect(screen.getByText("Some AI batches failed")).not.toBeNull();
    expect(screen.getByText(/1 of 3 batches failed: boom/)).not.toBeNull();
    expect(onSuggestRules).toHaveBeenCalledTimes(3);
  });
});
