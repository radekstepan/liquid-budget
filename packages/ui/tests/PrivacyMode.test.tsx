"use client";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createPrivacyMask,
  fmt,
  makeSeedBudgetData,
  maskBudgetData,
  num,
  todayISO,
  PRIVACY_ACCOUNT_NAMES,
  PRIVACY_PAYEE_NAMES,
  type BudgetData,
} from "@ynab/logic";

function isPoolName(pool: readonly string[], name: string): boolean {
  return pool.some((p) => name === p || name.startsWith(`${p} `));
}
import {
  BudgetApp,
  PRIVACY_STORAGE_KEY,
  type BudgetAppApi,
} from "../src/BudgetApp.js";
import { MenuSettingsView } from "../src/MenuSettingsView.js";
import { DEFAULT_NAV_VISIBILITY } from "../src/navVisibility.js";
import {
  guardApiForPrivacy,
  randomPrivacyFactor,
} from "../src/privacyApi.js";

const READ_METHODS = new Set([
  "reload",
  "getReconcileState",
  "listSnapshots",
  "getRenameSuggestStatus",
  "suggestRenameRules",
]);

/** Every BudgetAppApi member defined, so the guard can't miss one. */
function fullStubApi(): BudgetAppApi & Record<string, unknown> {
  const ok = vi.fn().mockResolvedValue(undefined);
  return {
    reload: vi.fn().mockResolvedValue(undefined),
    assign: ok,
    batchAssign: ok,
    addTransaction: ok,
    updateTransaction: ok,
    deleteTransaction: ok,
    bulkDeleteTransactions: ok,
    bulkUpdateTransactions: ok,
    mergeTransactions: ok,
    addRecurring: ok,
    updateRecurring: ok,
    deleteRecurring: ok,
    postRecurring: ok,
    bulkPostRecurring: ok,
    bulkUpdateRecurring: ok,
    bulkDeleteRecurring: ok,
    saveCategory: ok,
    deleteCategory: ok,
    reorderCategory: ok,
    reorderGroup: ok,
    saveGroup: ok,
    deleteGroup: ok,
    addAccount: ok,
    deleteAccount: ok,
    updateAccount: ok,
    reorderAccount: ok,
    reconcileAccount: ok,
    getReconcileState: vi.fn().mockResolvedValue({
      accountId: 1,
      accountName: "Real Account",
      workingBalance: 10000,
      unclearedTotal: 0,
      unclearedCount: 0,
      clearedCount: 0,
      reconciledCount: 0,
      lastReconciledAt: null,
      lastReconciledBalance: null,
    }),
    unreconcileAccount: ok,
    importYnab4: ok,
    importCsv: ok,
    analyzeDuplicates: ok,
    dismissDuplicateGroup: ok,
    addRenameRule: ok,
    updateRenameRule: ok,
    deleteRenameRule: ok,
    applyRenameRule: ok,
    getRenameSuggestStatus: vi.fn().mockResolvedValue({
      enabled: true,
      candidates: [{ payee: "Real Payee", count: 1 }],
      totalUnique: 1,
      truncated: false,
    }),
    suggestRenameRules: vi.fn().mockResolvedValue({
      suggestions: [],
      skipped: [],
      model: "test",
      processed: 0,
    }),
    acceptRenameSuggestions: ok,
    ensurePayee: ok,
    renamePayee: ok,
    setPayeeDefaultCategory: ok,
    mergePayees: ok,
    deletePayee: ok,
    listSnapshots: vi.fn().mockResolvedValue({
      snapshots: [
        { id: "a", name: "Before trip", createdAt: "2026-01-01", sizeBytes: 8 },
      ],
      suggestedName: "After trip",
    }),
    createSnapshot: ok,
    restoreSnapshot: ok,
    deleteSnapshot: ok,
  };
}

function maskForSeed(factor = 0.5) {
  const data = makeSeedBudgetData();
  return { data, mask: createPrivacyMask(data, factor) };
}

describe("randomPrivacyFactor", () => {
  it("draws factors inside the valid range, rounded to cents", () => {
    for (let i = 0; i < 50; i++) {
      const f = randomPrivacyFactor();
      expect(f).toBeGreaterThanOrEqual(0.15);
      expect(f).toBeLessThan(4);
      expect(Math.round(f * 100) / 100).toBe(f);
    }
  });
});

describe("guardApiForPrivacy", () => {
  it("blocks every mutation and reports it, resolving undefined", async () => {
    const api = fullStubApi();
    const onBlocked = vi.fn();
    const { mask } = maskForSeed();
    const guarded = guardApiForPrivacy(
      api,
      mask,
      onBlocked
    ) as unknown as Record<string, (...args: never[]) => Promise<unknown>>;

    for (const key of Object.keys(api)) {
      if (READ_METHODS.has(key)) continue;
      const res = await guarded[key]!();
      expect(res).toBeUndefined();
      expect(api[key] as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(onBlocked).toHaveBeenCalledWith(key);
    }
  });

  it("lets reads through and masks names and amounts in results", async () => {
    const api = fullStubApi();
    const onBlocked = vi.fn();
    const { mask } = maskForSeed(0.5);
    const guarded = guardApiForPrivacy(api, mask, onBlocked);

    await guarded.reload();
    expect(api.reload).toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();

    const state = await guarded.getReconcileState!(1);
    expect(state.accountName).toBe(mask.maskAccountName(1));
    expect(isPoolName(PRIVACY_ACCOUNT_NAMES, state.accountName)).toBe(true);
    expect(state.workingBalance).toBe(5000);

    const snaps = await guarded.listSnapshots!();
    expect(snaps.snapshots[0]!.name).toBe("Snapshot 1");
    expect(snaps.snapshots[0]!.id).toBe("a");
    expect(snaps.suggestedName).toBe("Snapshot");

    const status = await guarded.getRenameSuggestStatus!();
    expect(
      isPoolName(PRIVACY_PAYEE_NAMES, status.candidates[0]!.payee)
    ).toBe(true);
    expect(status.candidates[0]!.count).toBe(1);

    const suggestions = await guarded.suggestRenameRules!(0, 10);
    expect(suggestions.model).toBe("test");
    expect(api.suggestRenameRules).toHaveBeenCalledWith(0, 10);
  });

  it("keeps undefined optionals undefined (feature detection still works)", () => {
    const api = fullStubApi();
    delete api.suggestRenameRules;
    delete api.ensurePayee;
    const { mask } = maskForSeed();
    const guarded = guardApiForPrivacy(api, mask, vi.fn());
    expect(guarded.suggestRenameRules).toBeUndefined();
    expect(guarded.ensurePayee).toBeUndefined();
    expect(guarded.deletePayee).toBeDefined();
  });
});

describe("MenuSettingsView privacy section", () => {
  function renderSection(privacyEnabled: boolean) {
    const onTogglePrivacy = vi.fn();
    const onRegeneratePrivacyAmounts = vi.fn();
    render(
      <MenuSettingsView
        visible={{ ...DEFAULT_NAV_VISIBILITY }}
        onToggle={vi.fn()}
        privacyEnabled={privacyEnabled}
        onTogglePrivacy={onTogglePrivacy}
        onRegeneratePrivacyAmounts={onRegeneratePrivacyAmounts}
      />
    );
    return { onTogglePrivacy, onRegeneratePrivacyAmounts };
  }

  it("toggles privacy mode from the checkbox", () => {
    const { onTogglePrivacy } = renderSection(false);
    expect(
      screen.getByRole("heading", { name: "Privacy mode" })
    ).toBeInTheDocument();
    const box = screen.getByRole("checkbox", {
      name: "Disguise amounts and names",
    });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onTogglePrivacy).toHaveBeenCalledWith(true);
    expect(
      screen.queryByRole("button", { name: "New random amounts" })
    ).not.toBeInTheDocument();
  });

  it("offers new random amounts while enabled", () => {
    const { onRegeneratePrivacyAmounts } = renderSection(true);
    expect(
      screen.getByRole("checkbox", { name: "Disguise amounts and names" })
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "New random amounts" }));
    expect(onRegeneratePrivacyAmounts).toHaveBeenCalled();
  });
});

describe("BudgetApp privacy mode", () => {
  function stubApi(): BudgetAppApi {
    const ok = vi.fn().mockResolvedValue(undefined);
    return {
      reload: ok,
      assign: ok,
      addTransaction: ok,
      updateTransaction: ok,
      deleteTransaction: ok,
      addRecurring: ok,
      updateRecurring: ok,
      deleteRecurring: ok,
      postRecurring: ok,
      saveCategory: ok,
      deleteCategory: ok,
      reorderCategory: ok,
      reorderGroup: ok,
      saveGroup: ok,
      deleteGroup: ok,
      addAccount: ok,
      deleteAccount: ok,
      updateAccount: ok,
      reorderAccount: ok,
      reconcileAccount: ok,
      unreconcileAccount: ok,
    };
  }

  it("disguises account names and amounts behind the demo subtitle", () => {
    window.localStorage.setItem(
      PRIVACY_STORAGE_KEY,
      JSON.stringify({ enabled: true, factor: 0.5 })
    );
    render(
      <BudgetApp
        data={makeSeedBudgetData()}
        api={stubApi()}
        initialView="budget"
        initialMonth="2026-06"
      />
    );
    // Subtle indicator only: sidebar subtitle flips, nothing else shifts.
    expect(screen.getByText("MY DEMO BUDGET")).toBeInTheDocument();
    expect(screen.queryByText("MY BUDGET")).toBeNull();
    // Seed accounts are masked with realistic stand-ins; real names appear nowhere.
    const maskedFirst = createPrivacyMask(makeSeedBudgetData(), 0.5).maskAccountName(1);
    expect(screen.getAllByText(maskedFirst).length).toBeGreaterThan(0);
    expect(screen.queryByText("TD Unlimited Chequing")).toBeNull();
    expect(screen.queryByText("EQ Bank")).toBeNull();
    // Seed EQ balance 12454286¢ halved → $62,271.43.
    expect(screen.getByText("$62,271.43")).toBeInTheDocument();
    expect(screen.queryByText("$124,542.86")).toBeNull();
  });

  it("shows real data when privacy mode is off", () => {
    render(
      <BudgetApp
        data={makeSeedBudgetData()}
        api={stubApi()}
        initialView="budget"
        initialMonth="2026-06"
      />
    );
    expect(screen.queryByText("MY DEMO BUDGET")).toBeNull();
    expect(screen.getByText("MY BUDGET")).toBeInTheDocument();
    expect(screen.getByText("TD Unlimited Chequing")).toBeInTheDocument();
  });

  it("disguises payees and memos in the transactions view", () => {
    const seed = makeSeedBudgetData();
    window.localStorage.setItem(
      PRIVACY_STORAGE_KEY,
      JSON.stringify({ enabled: true, factor: 0.5 })
    );
    const { container } = render(
      <BudgetApp
        data={seed}
        api={stubApi()}
        initialView="budget"
        initialMonth="2026-06"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Transactions/ }));
    const text = container.textContent ?? "";
    // No real payee, account, or memo text survives anywhere rendered.
    // (Category names intentionally stay real, so names that only occur
    // inside a category/group label are excluded from this scan.)
    const kept = [
      ...seed.categories.map((c) => c.name),
      ...seed.groups.map((g) => g.name),
    ];
    const pool = [...PRIVACY_PAYEE_NAMES, ...PRIVACY_ACCOUNT_NAMES];
    const realNames = new Set<string>();
    for (const t of seed.transactions) {
      if (t.payee) realNames.add(t.payee);
      if (t.memo) realNames.add(t.memo);
    }
    for (const a of seed.accounts) realNames.add(a.name);
    for (const name of realNames) {
      if (kept.some((k) => k.includes(name))) continue;
      // A real name that is itself part of a stand-in (e.g. "Cash" in
      // "Cash Wallet") cannot be told apart by substring scan.
      if (pool.some((p) => p.includes(name))) continue;
      expect(text).not.toContain(name);
    }
    // ...but disguised pool names do render.
    expect(
      PRIVACY_PAYEE_NAMES.some((n) => text.includes(n))
    ).toBe(true);
    expect(
      PRIVACY_ACCOUNT_NAMES.some((n) => text.includes(n))
    ).toBe(true);
  });

  it("reports show disguised amounts and no real names", () => {
    const seed = makeSeedBudgetData();
    window.localStorage.setItem(
      PRIVACY_STORAGE_KEY,
      JSON.stringify({ enabled: true, factor: 0.5 })
    );
    render(
      <BudgetApp
        data={seed}
        api={stubApi()}
        initialView="budget"
        initialMonth="2026-06"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Reports", exact: true }));
    fireEvent.click(screen.getByText("Spending by Category"));

    // Expected top-category spend, computed per dataset (mirror of the
    // view's own aggregation over the default full-range selection).
    const spendByCat = (data: BudgetData): [string, number][] => {
      const parents = new Set(
        data.transactions
          .filter((t) => t.parentId != null)
          .map((t) => t.parentId!)
      );
      const thisMonth = todayISO().slice(0, 7);
      const months = [
        ...new Set(
          data.transactions
            .map((t) => t.date.slice(0, 7))
            .filter((m) => m <= thisMonth)
        ),
      ].sort();
      const start = months[0]!;
      const end = months[months.length - 1]!;
      const byCat = new Map<number, number>();
      for (const t of data.transactions) {
        if (parents.has(t.id)) continue;
        const mk = t.date.slice(0, 7);
        if (mk < start || mk > end) continue;
        if (t.categoryId == null) continue;
        byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) - num(t.amount));
      }
      const names = new Map(data.categories.map((c) => [c.id, c.name]));
      return [...byCat.entries()]
        .filter(([, v]) => v > 0)
        .map(([id, v]) => [names.get(id) ?? "—", v] as [string, number])
        .sort((a, b) => b[1] - a[1]);
    };
    const realTop = spendByCat(seed)[0]!;
    const masked = maskBudgetData(
      seed,
      createPrivacyMask(seed, 0.5)
    );
    const maskedTop = spendByCat(masked).find(
      ([name]) => name === realTop[0]
    )!;
    expect(maskedTop[1]).toBeGreaterThan(0);
    expect(maskedTop[1]).not.toBe(realTop[1]);

    // Category names stay real; the spend figure is the disguised one.
    expect(screen.getAllByText(realTop[0]).length).toBeGreaterThan(0);
    expect(screen.getAllByText(fmt(maskedTop[1])).length).toBeGreaterThan(0);
    expect(screen.queryByText(fmt(realTop[1]))).toBeNull();
    expect(screen.queryByText("TD Bank")).toBeNull();
    expect(screen.queryByText("Telus")).toBeNull();
  });

  it("turns off from the settings checkbox", () => {
    window.localStorage.setItem(
      PRIVACY_STORAGE_KEY,
      JSON.stringify({ enabled: true, factor: 0.5 })
    );
    render(
      <BudgetApp
        data={makeSeedBudgetData()}
        api={stubApi()}
        initialView="budget"
        initialMonth="2026-06"
      />
    );
    expect(screen.getByText("MY DEMO BUDGET")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByText("Page Visibility"));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Disguise amounts and names" })
    );
    expect(screen.queryByText("MY DEMO BUDGET")).toBeNull();
    expect(screen.getByText("MY BUDGET")).toBeInTheDocument();
    expect(screen.getByText("TD Unlimited Chequing")).toBeInTheDocument();
  });
});
