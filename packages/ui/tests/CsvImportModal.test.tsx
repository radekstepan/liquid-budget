import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CsvImportModal } from "../src/CsvImportModal.js";
import type { Account, Transaction } from "@ynab/logic";

const accounts: Account[] = [
  { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "10000", onBudget: true, sort: 0 },
  { id: 2, name: "Credit", kind: "credit", groupLabel: "Cards", balance: "-5000", onBudget: true, sort: 1 },
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

async function renderModal(
  csv: string,
  onImport = vi.fn().mockResolvedValue(undefined),
  transactions: Transaction[] = []
) {
  const view = render(
    <CsvImportModal
      accounts={accounts}
      transactions={transactions}
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

  it("swaps unconditionally and flags rows with an empty payee", async () => {
    await renderModal("Date,Payee,Outflow\n13/08/2026,UBER TRIP,18.63\n");
    fireEvent.click(screen.getByLabelText(/swap payee and memo/i));

    const rows = screen.getAllByRole("row");
    const first = rows[1]!;
    expect(first).toHaveClass("y-row--warn");
    const cells = within(first).getAllByRole("cell");
    expect(cells[1]!.textContent).toBe("Uncategorized");
    expect(cells[2]!.textContent).toBe("UBER TRIP");
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

  it("marks rows that duplicate an existing transaction and excludes them from import", async () => {
    const existing: Transaction[] = [
      {
        id: 1,
        accountId: 1,
        categoryId: null,
        date: "2026-08-13",
        payee: "PHNOM PENH RESTAURANT",
        memo: "Vancouver",
        amount: "-2808",
        status: "c",
        flagColor: null,
        parentId: null,
        transferAccountId: null,
      },
    ];
    await renderModal(validCsv, vi.fn().mockResolvedValue(undefined), existing);

    expect(screen.getByText("1 row(s) are duplicates and will be skipped")).toBeInTheDocument();
    expect(screen.getByText(/1 importable · 1 skipped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import 1 transaction$/i })).toBeEnabled();
  });

  it("marks duplicate rows within the same file", async () => {
    const dupCsv = [
      "Date,Payee,Outflow",
      "13/08/2026,UBER TRIP,18.63",
      "13/08/2026,UBER TRIP,18.63",
      "13/08/2026,WAL-MART,101.76",
    ].join("\n");
    await renderModal(dupCsv);

    expect(screen.getByText("1 row(s) are duplicates and will be skipped")).toBeInTheDocument();
    expect(screen.getByText(/2 importable · 1 skipped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import 2 transactions$/i })).toBeEnabled();
  });

  it("previews the renamed payee when a rename rule matches", async () => {
    const csv = [
      "Date,Payee,Outflow",
      "13/08/2026,BCF1,28.08",
      "13/08/2026,BCF22,18.63",
      "13/08/2026,UBER TRIP,11.11",
    ].join("\n");
    const view = render(
      <CsvImportModal
        accounts={accounts}
        transactions={[]}
        renameRules={[{ id: 1, sourcePattern: "BCF[N]", targetPayee: "BC Ferries", createdAt: "" }]}
        defaultAccountId={null}
        file={makeFile(csv)}
        onClose={() => {}}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />
    );
    await waitFor(() => {
      expect(screen.getAllByText("BC Ferries")).toHaveLength(2);
    });
    expect(screen.getByText("UBER TRIP")).toBeInTheDocument();
    view.unmount();
  });

  it("detects duplicates against existing transactions using the renamed payee", async () => {
    const existing: Transaction[] = [
      {
        id: 1,
        accountId: 1,
        categoryId: null,
        date: "2026-08-13",
        payee: "BC Ferries",
        memo: "",
        amount: "-2808",
        status: "c",
        flagColor: null,
        parentId: null,
        transferAccountId: null,
      },
    ];
    const csv = [
      "Date,Payee,Outflow",
      "13/08/2026,BCF1,28.08",
      "13/08/2026,UBER TRIP,11.11",
    ].join("\n");
    render(
      <CsvImportModal
        accounts={accounts}
        transactions={existing}
        renameRules={[{ id: 1, sourcePattern: "BCF[N]", targetPayee: "BC Ferries", createdAt: "" }]}
        defaultAccountId={null}
        file={makeFile(csv)}
        onClose={() => {}}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />
    );
    await waitFor(() => {
      expect(screen.getByText(/1 importable · 1 skipped/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^import 1 transaction$/i })).toBeEnabled();
  });

  it("handles US MM/DD CSV files consistently and allows changing date format", async () => {
    const usCsv = [
      "Date,Payee,Outflow",
      "08/13/2026,Store A,10.00",
      "08/05/2026,Store B,20.00",
    ].join("\n");
    const onImport = vi.fn().mockResolvedValue(undefined);
    await renderModal(usCsv, onImport);

    expect(screen.getByText("2026-08-13")).toBeInTheDocument();
    expect(screen.getByText("2026-08-05")).toBeInTheDocument();

    const select = screen.getByLabelText(/date format/i);
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "dmy" } });
    // In DMY format, 08/13/2026 is invalid (month 13) and 08/05/2026 is May 8
    await waitFor(() => {
      expect(screen.getByText("2026-05-08")).toBeInTheDocument();
    });
  });

  it("marks rows that duplicate an existing split parent transaction (BUG-21)", async () => {
    const existing: Transaction[] = [
      // Split parent
      {
        id: 10,
        accountId: 1,
        categoryId: null,
        date: "2026-08-13",
        payee: "PHNOM PENH RESTAURANT",
        memo: "Vancouver",
        amount: "-2808",
        status: "c",
        flagColor: null,
        parentId: null,
        transferAccountId: null,
      },
      // Split children
      {
        id: 11,
        accountId: 1,
        categoryId: null,
        date: "2026-08-13",
        payee: "PHNOM PENH RESTAURANT",
        memo: "Food",
        amount: "-1808",
        status: "c",
        flagColor: null,
        parentId: 10,
        transferAccountId: null,
      },
      {
        id: 12,
        accountId: 1,
        categoryId: null,
        date: "2026-08-13",
        payee: "PHNOM PENH RESTAURANT",
        memo: "Drinks",
        amount: "-1000",
        status: "c",
        flagColor: null,
        parentId: 10,
        transferAccountId: null,
      },
    ];

    await renderModal(validCsv, vi.fn().mockResolvedValue(undefined), existing);

    expect(screen.getByText("1 row(s) are duplicates and will be skipped")).toBeInTheDocument();
    expect(screen.getByText(/1 importable · 1 skipped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import 1 transaction$/i })).toBeEnabled();
  });

  it("marks rows that duplicate an existing transfer transaction (BUG-21)", async () => {
    const existing: Transaction[] = [
      {
        id: 20,
        accountId: 1,
        categoryId: null,
        date: "2026-08-03",
        payee: "PAYMENT RECEIVED - THANK YOU",
        memo: "",
        amount: "190803",
        status: "c",
        flagColor: null,
        parentId: null,
        transferAccountId: 2,
      },
    ];

    await renderModal(validCsv, vi.fn().mockResolvedValue(undefined), existing);

    expect(screen.getByText("1 row(s) are duplicates and will be skipped")).toBeInTheDocument();
    expect(screen.getByText(/1 importable · 1 skipped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^import 1 transaction$/i })).toBeEnabled();
  });
});
