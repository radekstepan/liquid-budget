import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import {
  SnapshotsView,
  formatSnapshotSize,
  type SnapshotSummary,
} from "../src/SnapshotsView.js";

const snapshots: SnapshotSummary[] = [
  { id: "20260907-120000-aaaaaa", name: "before import", createdAt: "2026-09-07T12:00:00.000Z", sizeBytes: 4341760 },
  { id: "20260906-090000-bbbbbb", name: "Whole Foods -$84.20 (2026-09-06)", createdAt: "2026-09-06T09:00:00.000Z", sizeBytes: 512 },
];

function renderView(over: Partial<Parameters<typeof SnapshotsView>[0]> = {}) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onRestore = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(
    <SnapshotsView
      snapshots={over.snapshots ?? snapshots}
      suggestedName={over.suggestedName ?? "Whole Foods -$84.20 (2026-09-06)"}
      loading={over.loading}
      error={over.error}
      onCreate={over.onCreate ?? onCreate}
      onRestore={over.onRestore ?? onRestore}
      onDelete={over.onDelete ?? onDelete}
    />
  );
  return { onCreate, onRestore, onDelete };
}

describe("SnapshotsView", () => {
  it("prefills the name input with the suggested name", () => {
    renderView();
    const input = screen.getByLabelText("Snapshot name");
    expect(input).toHaveValue("Whole Foods -$84.20 (2026-09-06)");
  });

  it("leaves the suggested name editable and saves the edited value", async () => {
    const { onCreate } = renderView();
    const input = screen.getByLabelText("Snapshot name");
    fireEvent.change(input, { target: { value: "before the big reconcile" } });
    expect(input).toHaveValue("before the big reconcile");

    fireEvent.click(screen.getByRole("button", { name: /save snapshot/i }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("before the big reconcile");
    });
  });

  it("saves the untouched suggestion verbatim", async () => {
    const { onCreate } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /save snapshot/i }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Whole Foods -$84.20 (2026-09-06)");
    });
  });

  it("lists snapshots with size and actions", () => {
    renderView();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("before import")).toBeInTheDocument();
    expect(table.getByText("4.1 MB")).toBeInTheDocument();
    expect(table.getByText("512 B")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /restore snapshot before import/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete snapshot before import/i })
    ).toBeInTheDocument();
  });

  it("confirms before restoring and calls onRestore", async () => {
    const { onRestore } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /restore snapshot before import/i }));
    expect(screen.getByText("Restore snapshot")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /yes, restore it/i }));
    await waitFor(() => {
      expect(onRestore).toHaveBeenCalledWith("20260907-120000-aaaaaa");
    });
  });

  it("confirms before deleting and calls onDelete", async () => {
    const { onDelete } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /delete snapshot before import/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith("20260907-120000-aaaaaa");
    });
  });

  it("shows an empty state when there are no snapshots", () => {
    renderView({ snapshots: [] });
    expect(screen.getByText(/no snapshots yet/i)).toBeInTheDocument();
  });

  it("surfaces errors", () => {
    renderView({ error: "disk is full" });
    expect(screen.getByText("disk is full")).toBeInTheDocument();
  });
});

describe("formatSnapshotSize", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatSnapshotSize(512)).toBe("512 B");
    expect(formatSnapshotSize(2048)).toBe("2.0 KB");
    expect(formatSnapshotSize(4341760)).toBe("4.1 MB");
    expect(formatSnapshotSize(-1)).toBe("—");
  });
});
