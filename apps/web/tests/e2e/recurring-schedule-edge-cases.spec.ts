// apps/web/tests/e2e/recurring-schedule-edge-cases.spec.ts
//
// Comprehensive End-to-End Test Suite for Recurring / Scheduled Transaction Edge Cases:
//   1. Posting a recurring split transaction inserts parent and all children into the register
//   2. Posting a recurring transfer transaction updates both accounts and advances next date
//   3. Scheduled drawer in register displays due transactions with inline Enter Now action
//   4. Editing recurring split sub-transactions updates draft amounts and categories
//   5. Bulk pausing, resuming, and deleting recurring rules

import { test, expect, type Page, type Locator } from "@playwright/test";
import { fillSearchlist, openSearchField, pickSubCategory } from "./helpers";

async function selectOption(scope: Locator, labelText: string, optionText: string, page: Page) {
  const field = scope.locator("label").filter({ hasText: labelText }).first();
  const trigger = field.locator('button[aria-haspopup="listbox"]').first();
  if (await trigger.isVisible()) {
    await trigger.click();
  }
  const searchInput = field.locator("input.y-select-search").first();
  if (await searchInput.isVisible()) {
    await searchInput.fill(optionText);
  }
  const option = page.locator('.y-dropdown button[role="option"]').filter({ hasText: optionText }).first();
  await expect(option).toBeVisible();
  await option.click();
}

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function gotoRecurring(page: Page) {
  await page.getByRole("button", { name: "Recurring", exact: true }).click();
  await expect(
    page.getByText("Recurring Transactions", { exact: true }).first()
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoRecurring(page);
});

test.describe("Recurring & Scheduled Transaction Edge Cases", () => {
  test("posting a recurring split transaction inserts parent and all children into the register", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW Recur Split Post ${stamp}`;

    // 1. Create a recurring split rule with total -$150:
    //    - Sub 1: -$100 (Category 1)
    //    - Sub 2: -$50 (Category 2)
    //    - Frequency: Monthly, nextDate = 2026-08-01
    await page.getByRole("button", { name: "Add Recurring" }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^split$/i }).click();

    await modal.locator('input[inputmode="decimal"]').first().fill("-150.00");
    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[type="date"]').first().fill("2026-08-01");

    // Sub 1: -$100 (pick first category)
    const childAmounts = modal.locator('input[inputmode="decimal"]');
    await childAmounts.nth(1).fill("-100.00");
    await pickSubCategory(modal, page, "Groceries");

    // Sub 2: -$50 (pick second category)
    await childAmounts.nth(2).fill("-50.00");
    await pickSubCategory(modal, page, "Household");

    await modal.getByRole("button", { name: "Save" }).click();
    await expect(modal).toBeHidden();

    // 2. Verify recurring card appears in Recurring view.
    const card = page.locator(".y-panel").filter({ hasText: payee }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("$150.00");

    const beforeRes = await page.request.get("/api/budget");
    const beforeData = await beforeRes.json();
    const recRule = beforeData.recurring.find((r: { payee: string }) => r.payee === payee);
    expect(recRule).toBeTruthy();
    const accountBefore = beforeData.accounts.find((a: { id: number }) => a.id === recRule.accountId);
    const balanceBefore = Number(accountBefore.balance);

    // 3. Click "Post Now" on the recurring split card.
    await card.getByRole("button", { name: "Post Now" }).click();

    // 4. Navigate to Transactions register:
    //    - Verify new split parent row is present with -$150 amount and "Split (Multiple Categories)".
    //    - Click row to open editor: verify sub-transactions (-$100, -$50) were created.
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    const txRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(txRow).toBeVisible();
    await expect(txRow).toContainText("Split (Multiple Categories)");
    await expect(txRow).toContainText("$150.00");

    await txRow.click();
    const editModal = page.locator(".y-modal").last();
    await expect(editModal.getByText("Edit Transaction")).toBeVisible();
    const editChildAmounts = editModal.locator('input[inputmode="decimal"]');
    await expect(editChildAmounts.nth(1)).toHaveValue("-100.00");
    await expect(editChildAmounts.nth(2)).toHaveValue("-50.00");
    await editModal.getByRole("button", { name: "Cancel" }).click();
    await expect(editModal).toBeHidden();

    // 5. Verify Checking balance decreases by $150.
    const afterRes = await page.request.get("/api/budget");
    const afterData = await afterRes.json();
    const accountAfter = afterData.accounts.find((a: { id: number }) => a.id === recRule.accountId);
    expect(Number(accountAfter.balance)).toBe(balanceBefore - 15000);

    const postedParent = afterData.transactions.find(
      (t: { payee: string; parentId: number | null }) => t.payee === payee && t.parentId == null
    );
    expect(postedParent).toBeTruthy();
    const children = afterData.transactions.filter(
      (t: { parentId: number | null }) => t.parentId === postedParent.id
    );
    expect(children).toHaveLength(2);
    expect(children.map((c: { amount: string }) => Number(c.amount)).sort()).toEqual([-10000, -5000].sort());

    // 6. Return to Recurring view: verify rule's nextDate advanced by exactly 1 month.
    await gotoRecurring(page);
    const updatedCard = page.locator(".y-panel").filter({ hasText: payee }).first();
    await expect(updatedCard).toBeVisible();
    await expect(updatedCard).toContainText("2026-09-01");
  });

  test("posting a recurring transfer transaction updates both accounts and advances next date", async ({ page }) => {
    // 1. Create a recurring transfer rule of -$200 from Checking to Savings (Bi-weekly frequency, nextDate = 2026-08-01).
    const initRes = await page.request.get("/api/budget");
    const initData = await initRes.json();
    const srcAcc = initData.accounts.find((a: { onBudget: boolean; kind: string }) => a.onBudget && a.kind === "liquid");
    const destAcc = initData.accounts.find((a: { id: number; onBudget: boolean }) => a.id !== srcAcc.id && a.onBudget);
    expect(srcAcc).toBeTruthy();
    expect(destAcc).toBeTruthy();
    const srcBalanceBefore = Number(srcAcc.balance);
    const destBalanceBefore = Number(destAcc.balance);

    await page.getByRole("button", { name: "Add Recurring" }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^transfer$/i }).click();

    await modal.locator('input[inputmode="decimal"]').first().fill("-200.00");
    await modal.locator('input[type="date"]').first().fill("2026-08-01");

    await selectOption(modal, "Frequency", "Every Other Week", page);

    await openSearchField(modal, "Select account…");
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: destAcc.name }).click();

    await modal.getByRole("button", { name: "Save" }).click();
    await expect(modal).toBeHidden();

    const card = page
      .locator(".y-panel")
      .filter({ hasText: `Transfer : ${destAcc.name}` })
      .filter({ hasText: "$200.00" })
      .first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("→");
    await expect(card).toContainText(destAcc.name);
    await expect(card).toContainText(/every other week/i);

    // 2. Click "Post Now" on the recurring card.
    await card.getByRole("button", { name: "Post Now" }).click();

    // 3. Verify Checking balance decreases by $200 and Savings balance increases by $200.
    await expect
      .poll(
        async () => {
          const res = await page.request.get("/api/budget");
          const body = await res.json();
          const src = body.accounts.find((a: { id: number }) => a.id === srcAcc.id);
          const dest = body.accounts.find((a: { id: number }) => a.id === destAcc.id);
          const rec = body.recurring.find(
            (r: { accountId: number; transferAccountId: number; amount: string }) =>
              r.accountId === srcAcc.id &&
              r.transferAccountId === destAcc.id &&
              Number(r.amount) === -20000
          );
          return {
            srcDelta: Number(src.balance) - srcBalanceBefore,
            destDelta: Number(dest.balance) - destBalanceBefore,
            nextDate: rec?.nextDate,
          };
        },
        { timeout: 10_000 }
      )
      .toMatchObject({
        srcDelta: -20000,
        destDelta: 20000,
        nextDate: "2026-08-15",
      });

    // 4. Verify transfer transaction appears in both Checking and Savings registers.
    await page.getByRole("button", { name: new RegExp(`^${srcAcc.name} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(srcAcc.name, { exact: true })).toBeVisible();
    const srcRow = page.getByRole("row").filter({ hasText: `Transfer : ${destAcc.name}` }).filter({ hasText: "$200.00" }).first();
    await expect(srcRow).toBeVisible();

    await page.getByRole("button", { name: new RegExp(`^${destAcc.name} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(destAcc.name, { exact: true })).toBeVisible();
    const destRow = page.getByRole("row").filter({ hasText: `Transfer : ${srcAcc.name}` }).filter({ hasText: "$200.00" }).first();
    await expect(destRow).toBeVisible();

    // 5. Verify recurring card nextDate advanced by 14 days (to 2026-08-15).
    await gotoRecurring(page);
    const updatedCard = page
      .locator(".y-panel")
      .filter({ hasText: `Transfer : ${destAcc.name}` })
      .filter({ hasText: "$200.00" })
      .first();
    await expect(updatedCard).toBeVisible();
    await expect(updatedCard).toContainText("2026-08-15");
  });

  test("scheduled drawer in register displays due transactions with inline Enter Now action", async ({ page }) => {
    // 1. Ensure a recurring transaction has nextDate <= today.
    const stamp = Date.now();
    const payee = `PW Sched Drawer ${stamp}`;

    await page.getByRole("button", { name: "Add Recurring" }).click();
    const modal = page.locator(".y-modal").last();
    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[inputmode="decimal"]').first().fill("-75.00");
    await modal.locator('input[type="date"]').first().fill("2026-08-01");
    await modal.getByRole("button", { name: "Save" }).click();
    await expect(modal).toBeHidden();

    // 2. Navigate to Transactions register.
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    // 3. Verify Scheduled Drawer is visible (or open it via toggle).
    const drawer = page.locator(".y-scheduled-drawer");
    if (!(await drawer.isVisible())) {
      await page.getByRole("button", { name: /Scheduled Transactions/i }).click();
      await expect(drawer).toBeVisible();
    }

    // 4. Verify due transaction is listed with its payee, account, and amount.
    const schedRow = page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee }).first();
    await expect(schedRow).toBeVisible();
    await expect(schedRow).toContainText("2026-08-01");
    await expect(schedRow).toContainText("$75.00");

    // 5. Click inline row to open modal and click "Enter Now".
    await schedRow.click();
    const editModal = page.locator(".y-modal").last();
    await expect(editModal.getByText("Edit Recurring Transaction")).toBeVisible();
    const enterNowBtn = editModal.getByRole("button", { name: "Enter Now" });
    await expect(enterNowBtn).toBeVisible();
    await enterNowBtn.click();
    await expect(editModal).toBeHidden();

    // 6. Verify the row moves into the active register as a real transaction.
    const activeTxRow = page
      .locator("table.y-table:not(.y-scheduled-table) tbody tr")
      .filter({ hasText: payee })
      .first();
    await expect(activeTxRow).toBeVisible();
    await expect(activeTxRow).toContainText("$75.00");

    // 7. Verify the scheduled drawer updates its due status / nextDate advances.
    const updatedSchedRow = page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee }).first();
    if (await updatedSchedRow.isVisible()) {
      await expect(updatedSchedRow).toContainText("2026-09-01");
    }
  });

  test("editing recurring split sub-transactions updates draft amounts and categories", async ({ page }) => {
    // 1. Open edit modal on an existing recurring split rule.
    const stamp = Date.now();
    const payee = `PW Edit Recur Split ${stamp}`;

    await page.getByRole("button", { name: "Add Recurring" }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.getByRole("button", { name: /^split$/i }).click();

    await fillSearchlist(addModal, "e.g. Whole Foods", payee);
    const allDecimals = addModal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("-100.00");

    await pickSubCategory(addModal, page, 1);
    await pickSubCategory(addModal, page, 2);

    await allDecimals.nth(1).fill("-60.00");
    await allDecimals.nth(2).fill("-40.00");

    await addModal.locator('input[type="date"]').first().fill("2026-08-01");
    await addModal.getByRole("button", { name: "Save" }).click();
    await expect(addModal).toBeHidden();

    const card = page.locator(".y-panel").filter({ hasText: payee }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("2 categories");

    await page.getByRole("button", { name: `Edit ${payee}` }).click();
    const editModal = page.locator(".y-modal").last();
    await expect(editModal.getByText("Edit Recurring Transaction")).toBeVisible();

    // 2. Add a 3rd sub-row, change categories and adjust amounts.
    await editModal.getByRole("button", { name: "+ Add sub-transaction" }).click();

    const editDecimals = editModal.locator('input[inputmode="decimal"]');
    await editDecimals.nth(0).fill("-150.00");

    await pickSubCategory(editModal, page, 3);

    await editDecimals.nth(1).fill("-70.00");
    await editDecimals.nth(2).fill("-50.00");
    await editDecimals.nth(3).fill("-30.00");

    // 3. Save changes.
    const saveBtn = editModal.getByRole("button", { name: "Save Changes" });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(editModal).toBeHidden();

    // 4. Verify card renders updated "3 categories" badge.
    await expect(card).toContainText("3 categories");
    await expect(card).toContainText("-$150.00");

    // 5. Post the rule now and verify the posted split transaction contains all 3 updated sub-transactions.
    await card.getByRole("button", { name: "Post Now" }).click();

    await expect
      .poll(
        async () => {
          const res = await page.request.get("/api/budget");
          const body = await res.json();
          const parent = body.transactions.find(
            (t: { payee: string; parentId: number | null }) => t.payee === payee && t.parentId == null
          );
          if (!parent) return 0;
          const children = body.transactions.filter(
            (t: { parentId: number | null }) => t.parentId === parent.id
          );
          return children.length;
        },
        { timeout: 10_000 }
      )
      .toBe(3);

    const res = await page.request.get("/api/budget");
    const body = await res.json();
    const parent = body.transactions.find(
      (t: { payee: string; parentId: number | null }) => t.payee === payee && t.parentId == null
    );
    const children = body.transactions.filter(
      (t: { parentId: number | null }) => t.parentId === parent.id
    );
    expect(children.map((c: { amount: string }) => Number(c.amount)).sort()).toEqual([-7000, -5000, -3000].sort());
  });

  test("bulk pausing, resuming, and deleting recurring rules", async ({ page }) => {
    // 1. Create 3 distinct recurring rules.
    const stamp = Date.now();
    const payee1 = `PW BulkRecur 1 ${stamp}`;
    const payee2 = `PW BulkRecur 2 ${stamp}`;
    const payee3 = `PW BulkRecur 3 ${stamp}`;

    for (const p of [payee1, payee2, payee3]) {
      await page.getByRole("button", { name: "Add Recurring" }).click();
      const modal = page.locator(".y-modal").last();
      await fillSearchlist(modal, "e.g. Whole Foods", p);
      await modal.locator('input[inputmode="decimal"]').first().fill("-15.00");
      await modal.locator('input[type="date"]').first().fill("2026-08-01");
      await modal.getByRole("button", { name: "Save" }).click();
      await expect(modal).toBeHidden();
    }

    const card1 = page.locator(".y-panel").filter({ hasText: payee1 }).first();
    const card2 = page.locator(".y-panel").filter({ hasText: payee2 }).first();
    const card3 = page.locator(".y-panel").filter({ hasText: payee3 }).first();
    await expect(card1).toBeVisible();
    await expect(card2).toBeVisible();
    await expect(card3).toBeVisible();

    // 2. Pause rules via pill toggle: verify all 3 rules display "Paused" badge.
    await card1.getByRole("button", { name: `Pause ${payee1}` }).click();
    await card2.getByRole("button", { name: `Pause ${payee2}` }).click();
    await card3.getByRole("button", { name: `Pause ${payee3}` }).click();

    await expect(card1.locator(".y-pill").filter({ hasText: "Paused" })).toBeVisible();
    await expect(card2.locator(".y-pill").filter({ hasText: "Paused" })).toBeVisible();
    await expect(card3.locator(".y-pill").filter({ hasText: "Paused" })).toBeVisible();

    // 3. Resume rules via pill toggle: verify all 3 rules display "Active" status.
    await card1.getByRole("button", { name: `Resume ${payee1}` }).click();
    await card2.getByRole("button", { name: `Resume ${payee2}` }).click();
    await card3.getByRole("button", { name: `Resume ${payee3}` }).click();

    await expect(card1.locator(".y-pill").filter({ hasText: "Active" })).toBeVisible();
    await expect(card2.locator(".y-pill").filter({ hasText: "Active" })).toBeVisible();
    await expect(card3.locator(".y-pill").filter({ hasText: "Active" })).toBeVisible();

    // 4. Navigate to Transactions register and open Scheduled Drawer.
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    const drawer = page.locator(".y-scheduled-drawer");
    if (!(await drawer.isVisible())) {
      await page.getByRole("button", { name: /Scheduled Transactions/i }).click();
      await expect(drawer).toBeVisible();
    }

    const sRow1 = page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee1 }).first();
    const sRow2 = page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee2 }).first();
    const sRow3 = page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee3 }).first();

    await expect(sRow1).toBeVisible();
    await expect(sRow2).toBeVisible();
    await expect(sRow3).toBeVisible();

    // 5. Select all 3 using their row checkboxes in the scheduled drawer.
    await sRow1.locator('input[type="checkbox"]').click();
    await sRow2.locator('input[type="checkbox"]').click();
    await sRow3.locator('input[type="checkbox"]').click();

    await expect(page.getByText("3 scheduled selected")).toBeVisible();

    // 6. Click "Delete (3)" in bulk bar -> verify all 3 rules are deleted.
    await page.getByRole("button", { name: "Delete (3)" }).click();

    await expect(page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee1 })).toHaveCount(0);
    await expect(page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee2 })).toHaveCount(0);
    await expect(page.locator(".y-scheduled-table tbody tr").filter({ hasText: payee3 })).toHaveCount(0);

    // Return to Recurring view: verify all 3 cards are removed from RecurringView.
    await gotoRecurring(page);
    await expect(page.getByText(payee1, { exact: true })).toHaveCount(0);
    await expect(page.getByText(payee2, { exact: true })).toHaveCount(0);
    await expect(page.getByText(payee3, { exact: true })).toHaveCount(0);
  });
});
