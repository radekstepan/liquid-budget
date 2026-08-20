import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CsvImportModal } from "../src/CsvImportModal.js";
import type { Account, Category } from "@ynab/logic";

const accounts: Account[] = [
  { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "10000", onBudget: true, sort: 0 },
  { id: 2, name: "Credit", kind: "credit", groupLabel: "Cards", balance: "-5000", onBudget: true, sort: 1 },
];

const categories: Category[] = [
  { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
];

const validCsv = [
  "Date,Payee,Category,Memo,Outflow,Inflow",
  "13/08/2026,PHNOM PENH RESTAURANT,,Vancouver,28.08,",
  "03/08/2026,PAYMENT RECEIVED - THANK YOU,,,,1908.03",
].join("\n");

function makeFile(content: string) {
  const f = new File([content], "import.csv", { type: "text/csv" });
  (f as unknown as { text: () => Promise<string> }).text = () => Promise.resolve(content);
  return f;
}

async function renderModal(csv: string, onImport = vi.fn().mockResolvedValue(undefined)) {
  const view = render(
    <CsvImportModal
      accounts={accounts}
      categories={categories}
      defaultAccountId={null}
      file={makeFile(csv)}
      onClose={() => {}}
      onImport={onImport}
    />
  );
  await waitFor(() => {
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });
  return { view, onImport };
}

describe("CsvImportModal", () => {
  it("renders a preview of parsed rows with amounts", async () => {
    await renderModal(validCsv);
    expect(screen.getByText("PHNOM PENH RESTAURANT")).toBeInTheDocument();
    expect(screen.getByText("PAYMENT RECEIVED - THANK YOU")).toBeInTheDocument();
    expect(screen.getByText("Vancouver")).toBeInTheDocument();
    expect(screen.getByText("-$28.08")).toBeInTheDocument();
    expect(screen.getByText("$1,908.03")).toBeInTheDocument();
    expect(screen.getByText(/2 importable · 0 skipped/)).toBeInTheDocument();
  });

  it("swaps payee and memo columns when the toggle is on", async () => {
    await renderModal(validCsv);
    fireEvent.click(screen.getByLabelText(/swap payee and memo/i));

    const rows = screen.getAllByRole("row");
    const first = rows[1]!;
    const cells = within(first).getAllByRole("cell");
    await waitFor(() => expect(cells[1]!.textContent).toBe("Vancouver"));
    expect(cells[2]!.textContent).toBe("PHNOM PENH RESTAURANT");
  });

  it("imports a single-row file and defaults to the first account", async () => {
    await renderModal("Date,Payee,Outflow\n13/08/2026,UBER TRIP,18.63\n");
    expect(screen.getByRole("button", { name: /^import 1 transaction$/i })).toBeEnabled();
  });

  it("previews invalid rows with their reason while disabling import", async () => {
    await renderModal("Date,Payee,Outflow\n13/13/2026,UBER TRIP,18.63\n13/08/2026,WAL-MART,101.76\n");
    expect(screen.getByText("UBER TRIP")).toBeInTheDocument();
    expect(screen.getByText("WAL-MART")).toBeInTheDocument();
    expect(screen.getAllByText(/Invalid date/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^import 1 transaction$/i })).toBeDisabled();
    expect(screen.getByText(/1 importable · 1 skipped/)).toBeInTheDocument();
    expect(screen.getByText("1 row(s) skipped")).toBeInTheDocument();
  });

  it("calls onImport with the account, swap flag, and csv text", async () => {
    const onImport = vi.fn().mockResolvedValue(undefined);
    await renderModal(validCsv, onImport);
    fireEvent.click(screen.getByLabelText(/swap payee and memo/i));
    fireEvent.click(screen.getByRole("button", { name: /^import 2 transactions$/i }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const [arg] = onImport.mock.calls[0] as [
      { accountId: number; swap: boolean; csv: string }
    ];
    expect(arg.accountId).toBe(1);
    expect(arg.swap).toBe(true);
    expect(arg.csv).toContain("PHNOM PENH RESTAURANT");
  });

  it("surfaces an import failure without closing the modal", async () => {
    const onImport = vi.fn().mockRejectedValue(new Error("boom"));
    await renderModal(validCsv, onImport);
    fireEvent.click(screen.getByRole("button", { name: /^import 2 transactions$/i }));

    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^import 2 transactions$/i })).toBeEnabled();
  });
});
