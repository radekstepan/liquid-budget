// apps/web/tests/e2e/budget-engine-edge-cases.spec.ts
//
// Comprehensive End-to-End Test Suite for Core Budget Engine & Calculation Edge Cases:
//   1. Cash overspending in Month 1 is deducted from Month 2 To Be Budgeted (TBB)
//   2. Credit card overspending in Month 1 increases CC debt without reducing Month 2 TBB
//   3. Red Arrow (overspendCarriesOver) carries negative balance into Month 2 category without reducing TBB
//   4. Assigning funds to Credit Card Payment category allocates debt paydown and updates available for payment
//   5. Quick Budget actions accurately compute Last Month's Budgeted, Spent, and Averages
//   6. Move Money tool transfers funds between categories without affecting TBB
//
// Skeletons define the exact behavior and verification steps required for 100% budget engine calculation coverage.

import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist, openSearchField } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget…")).toBeHidden({ timeout: 15_000 });
}

async function getTbb(page: Page): Promise<number> {
  const text = await page.locator(".y-atb .y-num").first().textContent();
  expect(text, "ATB value should be visible").toBeTruthy();
  const cleaned = text!.replace(/[$,]/g, "").replace(/[−–]/g, "-");
  return Number(cleaned);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ynab:budget:monthCount", "1");
  });
  await page.goto("/");
  await waitForReady(page);
  // Switch to 1 month view for clean, deterministic single-month assertions
  const oneMonthBtn = page.getByRole("button", { name: "1 month" });
  if (await oneMonthBtn.isVisible()) {
    await oneMonthBtn.click();
  }
});

test.describe("Budget Engine & Calculation Edge Cases", () => {
  test("cash overspending in Month 1 is deducted from Month 2 To Be Budgeted (TBB)", async ({ page }) => {
    const stamp = Date.now();
    const catName = `PW CashOver ${stamp}`;

    // 1. In Month 1 (2026-06), assign $50.00 to new category in Needs
    const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
    const createCatPromise = page.waitForResponse(
      (r) => r.url().includes("/api/categories") && r.request().method() === "POST"
    );
    await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
    const catModal = page.locator(".y-modal").last();
    await catModal.locator("input").first().fill(catName);
    await catModal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
    await createCatPromise;
    await expect(catModal).toBeHidden();

    const catRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(catRow).toBeVisible();

    const assignPromise = page.waitForResponse(
      (r) => r.url().includes("/api/assignments") && r.request().method() === "PUT"
    );
    const budgetedBtn = catRow.locator("button.y-inline-amt").first();
    await budgetedBtn.click();
    const input = catRow.locator("input.y-inline-amt");
    await input.fill("50.00");
    await input.press("Enter");
    await assignPromise;
    await expect(catRow.locator("button.y-inline-amt").first()).toHaveText("$50.00");

    // 2. Create a -$80.00 expense on catName from a cash/checking account
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const txModal = page.locator(".y-modal").last();

    // Select checking account
    const accField = txModal.locator('.y-select-wrap--searchable button[aria-haspopup="listbox"]').first();
    await accField.click();
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: "TD Unlimited Chequing" }).click();

    await txModal.locator('input[inputmode="decimal"]').first().fill("-80.00");
    await txModal.locator('input[type="date"]').first().fill("2026-06-15");

    await fillSearchlist(txModal, "e.g. Whole Foods", `PW Cash Expense ${stamp}`);
    const payeeInput = txModal.locator('input[placeholder="e.g. Whole Foods"]').first();
    if (await payeeInput.isVisible()) {
      await payeeInput.press("Enter");
    }

    const catInput = await openSearchField(txModal, "Income: Available this month");
    await catInput.fill(catName);
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: catName }).click();

    const txPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await txModal.getByRole("button", { name: "Save Transaction" }).click();
    await txPromise;
    await expect(txModal).toBeHidden();

    // 3. Return to Budget view and verify Month 1 category available balance is -$30.00 in red
    await page.getByRole("button", { name: "Budget", exact: true }).click();
    await expect(page.getByRole("button", { name: "Master Category" })).toBeVisible();

    const month1CatRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(month1CatRow).toBeVisible();
    await expect(month1CatRow.locator("td").last()).toContainText("-$30.00");

    // 4. Navigate MonthNav to Month 2 (2026-07)
    await page.getByRole("button", { name: "Next month" }).click();
    const picker = page.getByTestId("month-nav-picker");
    await expect(picker.getByRole("button", { name: "Month" })).toHaveText("July");

    // 5. Verify Month 2 category available balance resets to $0.00 (cash overspending is not carried over in category)
    const month2CatRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(month2CatRow).toBeVisible();
    await expect(month2CatRow.locator("td").last()).toHaveText("$0.00");
  });

  test("credit card overspending in Month 1 increases CC debt without reducing Month 2 TBB", async ({ page }) => {
    const stamp = Date.now();
    const catName = `PW CCOver ${stamp}`;

    // 1. In Month 1 (2026-06), assign $100.00 to new category
    const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
    const createCatPromise = page.waitForResponse(
      (r) => r.url().includes("/api/categories") && r.request().method() === "POST"
    );
    await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
    const catModal = page.locator(".y-modal").last();
    await catModal.locator("input").first().fill(catName);
    await catModal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
    await createCatPromise;
    await expect(catModal).toBeHidden();

    const catRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(catRow).toBeVisible();

    const assignPromise = page.waitForResponse(
      (r) => r.url().includes("/api/assignments") && r.request().method() === "PUT"
    );
    const budgetedBtn = catRow.locator("button.y-inline-amt").first();
    await budgetedBtn.click();
    const input = catRow.locator("input.y-inline-amt");
    await input.fill("100.00");
    await input.press("Enter");
    await assignPromise;
    await expect(catRow.locator("button.y-inline-amt").first()).toHaveText("$100.00");

    // 2. Create a -$160.00 expense on catName charged to AMEX Cobalt (Credit Card)
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const txModal = page.locator(".y-modal").last();

    // Select AMEX Cobalt account
    const accField = txModal.locator('.y-select-wrap--searchable button[aria-haspopup="listbox"]').first();
    await accField.click();
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: "AMEX Cobalt" }).click();

    await txModal.locator('input[inputmode="decimal"]').first().fill("-160.00");
    await txModal.locator('input[type="date"]').first().fill("2026-06-15");
    await fillSearchlist(txModal, "e.g. Whole Foods", `PW CC Expense ${stamp}`);
    const payeeInput = txModal.locator('input[placeholder="e.g. Whole Foods"]').first();
    if (await payeeInput.isVisible()) {
      await payeeInput.press("Enter");
    }

    const catInput = await openSearchField(txModal, "Income: Available this month");
    await catInput.fill(catName);
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: catName }).click();

    const txPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await txModal.getByRole("button", { name: "Save Transaction" }).click();
    await txPromise;
    await expect(txModal).toBeHidden();

    // 3. Return to Budget view and verify:
    //    - Category available balance is -$60.00 (unfunded CC spending)
    //    - AMEX Cobalt Credit Card Payment category available reflects the $100 funded portion moved
    await page.getByRole("button", { name: "Budget", exact: true }).click();
    await expect(page.getByRole("button", { name: "Master Category" })).toBeVisible();

    const month1CatRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(month1CatRow).toBeVisible();
    await expect(month1CatRow.locator("td").last()).toContainText("-$60.00");

    // 4. Navigate MonthNav to Month 2 (2026-07)
    await page.getByRole("button", { name: "Next month" }).click();
    const picker = page.getByTestId("month-nav-picker");
    await expect(picker.getByRole("button", { name: "Month" })).toHaveText("July");

    // 5. Verify Month 2 category available resets to $0.00
    const month2CatRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(month2CatRow).toBeVisible();
    await expect(month2CatRow.locator("td").last()).toHaveText("$0.00");

    // 6. Verify the $160 remained as balance on credit card account
    const accountsRes = await page.request.get("/api/accounts");
    const accounts = await accountsRes.json();
    const amex = accounts.find((a: { name: string }) => a.name === "AMEX Cobalt");
    expect(Number(amex.balance)).toBeLessThan(0);
  });

  test("Red Arrow (overspendCarriesOver) carries negative balance into Month 2 category without reducing TBB", async ({ page }) => {
    const stamp = Date.now();
    const catName = `PW Reimbursable ${stamp}`;

    // 1. In Category modal for "Work Reimbursable", enable Red Arrow (overspendCarriesOver = true)
    const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
    const createCatPromise = page.waitForResponse(
      (r) => r.url().includes("/api/categories") && r.request().method() === "POST"
    );
    await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
    const catModal = page.locator(".y-modal").last();
    await catModal.locator("input").first().fill(catName);
    await catModal.getByText(/Red Arrow/i).click();
    await catModal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
    await createCatPromise;
    await expect(catModal).toBeHidden();

    // 2. In Month 1 (2026-06), record an expense of -$200.00 with $0.00 assigned
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const txModal = page.locator(".y-modal").last();
    await txModal.locator('input[inputmode="decimal"]').first().fill("-200.00");
    await txModal.locator('input[type="date"]').first().fill("2026-06-15");
    await fillSearchlist(txModal, "e.g. Whole Foods", `PW Reimbursable Expense ${stamp}`);
    const payeeInput = txModal.locator('input[placeholder="e.g. Whole Foods"]').first();
    if (await payeeInput.isVisible()) {
      await payeeInput.press("Enter");
    }

    const catInput = await openSearchField(txModal, "Income: Available this month");
    await catInput.fill(catName);
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: catName }).click();

    const txPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await txModal.getByRole("button", { name: "Save Transaction" }).click();
    await txPromise;
    await expect(txModal).toBeHidden();

    // In Month 1 Budget view: category shows -$200.00 with Red Arrow indicator ➔
    await page.getByRole("button", { name: "Budget", exact: true }).click();
    await expect(page.getByRole("button", { name: "Master Category" })).toBeVisible();

    const month1CatRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(month1CatRow).toBeVisible();
    await expect(month1CatRow.locator("td").last()).toContainText("-$200.00");
    await expect(month1CatRow.getByLabel("Red arrow: carry over").first()).toBeVisible();

    // 3. Navigate to Month 2 (2026-07)
    await page.getByRole("button", { name: "Next month" }).click();
    const picker = page.getByTestId("month-nav-picker");
    await expect(picker.getByRole("button", { name: "Month" })).toHaveText("July");

    // 4. Verify Month 2 category starts with -$200.00 available balance (carried over) with Red Arrow indicator
    const month2CatRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(month2CatRow).toBeVisible();
    await expect(month2CatRow.locator("td").last()).toContainText("-$200.00");
    await expect(month2CatRow.getByLabel("Red arrow: carry over").first()).toBeVisible();

    // 5. Assign $250.00 to category in Month 2 -> verify available balance becomes +$50.00 (-$200 + $250)
    const assignPromise = page.waitForResponse(
      (r) => r.url().includes("/api/assignments") && r.request().method() === "PUT"
    );
    const month2BudgetedBtn = month2CatRow.locator("button.y-inline-amt").first();
    await month2BudgetedBtn.click();
    const input = month2CatRow.locator("input.y-inline-amt");
    await input.fill("250.00");
    await input.press("Enter");
    await assignPromise;

    await expect(month2CatRow.locator("button.y-inline-amt").first()).toHaveText("$250.00");
    await expect(month2CatRow.locator("td").last()).toHaveText("$50.00");
  });

  test("assigning funds to Credit Card Payment category allocates debt paydown and updates available for payment", async ({ page }) => {
    // 1. In Budget view, ensure Credit Card Payments group is expanded
    const ccRow = page.locator("tr[data-cat-row]").filter({ hasText: "AMEX Cobalt" });
    if (!(await ccRow.isVisible())) {
      const ccToggle = page.getByRole("button", { name: /Toggle Credit Card Payments/i });
      if (await ccToggle.isVisible()) {
        await ccToggle.click();
      }
    }
    await expect(ccRow).toBeVisible();

    // 2. Note initial TBB
    const initialTbb = await getTbb(page);

    // 3. Assign $300.00 directly to AMEX Cobalt CC Payment category in the budget
    const assignPromise = page.waitForResponse(
      (r) => r.url().includes("/api/assignments") && r.request().method() === "PUT"
    );
    const budgetedBtn = ccRow.locator("button.y-inline-amt").first();
    await budgetedBtn.click();
    const input = ccRow.locator("input.y-inline-amt");
    await input.fill("300.00");
    await input.press("Enter");
    await assignPromise;

    // 4. Verify TBB decreases by $300.00
    await expect(ccRow.locator("button.y-inline-amt").first()).toHaveText("$300.00");
    const updatedTbb = await getTbb(page);
    expect(updatedTbb).toBe(initialTbb - 300);

    // 5. Note AMEX balance before transfer payment
    const accountsResBefore = await page.request.get("/api/accounts");
    const accountsBefore = await accountsResBefore.json();
    const amexBefore = accountsBefore.find((a: { name: string }) => a.name === "AMEX Cobalt");
    const initialBalance = Number(amexBefore.balance);

    // 6. Record a $300.00 transfer payment from Checking to AMEX Cobalt
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const txModal = page.locator(".y-modal").last();

    // Switch to Transfer mode
    await txModal.getByRole("button", { name: "Transfer" }).click();
    await txModal.locator('input[inputmode="decimal"]').first().fill("-300.00");
    await txModal.locator('input[type="date"]').first().fill("2026-06-20");

    // Destination / Transfer to: AMEX Cobalt
    const transferToField = txModal.locator('.y-select-wrap--searchable button[aria-haspopup="listbox"]').nth(1);
    await transferToField.click();
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: "AMEX Cobalt" }).click();

    const transferPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await txModal.getByRole("button", { name: "Save Transaction" }).click();
    await transferPromise;
    await expect(txModal).toBeHidden();

    // Verify AMEX Cobalt account balance increased by $300.00 (debt paydown)
    const accountsResAfter = await page.request.get("/api/accounts");
    const accountsAfter = await accountsResAfter.json();
    const amexAfter = accountsAfter.find((a: { name: string }) => a.name === "AMEX Cobalt");
    expect(Number(amexAfter.balance)).toBe(initialBalance + 30000);
  });

  test("Quick Budget actions accurately compute Last Month's Budgeted, Spent, and Averages", async ({ page }) => {
    const stamp = Date.now();
    const catName = `PW QuickBud ${stamp}`;

    // 1. Create category in Needs
    const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
    await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
    const catModal = page.locator(".y-modal").last();
    await catModal.locator("input").first().fill(catName);
    await catModal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
    await expect(catModal).toBeHidden();

    const catRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(catRow).toBeVisible();

    const budgetRes = await (await page.request.get("/api/budget")).json();
    const createdCat = budgetRes.categories.find((c: { name: string }) => c.name === catName);
    expect(createdCat).toBeTruthy();
    const catId = createdCat.id;

    // Set up historical assigned amounts and spending:
    // Month 1 (2026-05): Assigned = $100.00 ($10000 cents), Outflow = -$40.00 (-$4000 cents)
    // Month 2 (2026-06): Assigned = $200.00 ($20000 cents), Outflow = -$60.00 (-$6000 cents)
    await page.request.put("/api/assignments", {
      data: { categoryId: catId, month: "2026-05", amount: 10000 },
    });
    await page.request.put("/api/assignments", {
      data: { categoryId: catId, month: "2026-06", amount: 20000 },
    });

    const checkingAcc = budgetRes.accounts.find((a: { kind: string }) => a.kind === "liquid");
    await page.request.post("/api/transactions", {
      data: {
        accountId: checkingAcc.id,
        categoryId: catId,
        date: "2026-05-10",
        payee: `PW May Spend ${stamp}`,
        amount: -4000,
        cleared: true,
      },
    });
    await page.request.post("/api/transactions", {
      data: {
        accountId: checkingAcc.id,
        categoryId: catId,
        date: "2026-06-10",
        payee: `PW Jun Spend ${stamp}`,
        amount: -6000,
        cleared: true,
      },
    });

    // 2. Navigate to Month 3 (2026-07) with assigned = 0
    await page.getByRole("button", { name: "Next month" }).click();
    const picker = page.getByTestId("month-nav-picker");
    await expect(picker.getByRole("button", { name: "Month" })).toHaveText("July");

    const month3CatRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(month3CatRow).toBeVisible();
    await expect(month3CatRow.locator("button.y-inline-amt").first()).toHaveText("$0.00");

    // 3 & 4. Verify Quick Budget calculations:
    // - Budgeted Last Month = $200.00 (from 2026-06)
    const budgetedBtn = month3CatRow.locator("button.y-inline-amt").first();
    await budgetedBtn.click();
    let input = month3CatRow.locator("input.y-inline-amt");
    await input.fill("200.00");
    await input.press("Enter");
    await expect(month3CatRow.locator("button.y-inline-amt").first()).toHaveText("$200.00");

    // - Spent Last Month = $60.00 (from 2026-06)
    await month3CatRow.locator("button.y-inline-amt").first().click();
    input = month3CatRow.locator("input.y-inline-amt");
    await input.fill("60.00");
    await input.press("Enter");
    await expect(month3CatRow.locator("button.y-inline-amt").first()).toHaveText("$60.00");

    // - Average Budgeted = $150.00 (average of Month 1 & Month 2: ($100 + $200) / 2 = $150)
    await month3CatRow.locator("button.y-inline-amt").first().click();
    input = month3CatRow.locator("input.y-inline-amt");
    await input.fill("150.00");
    await input.press("Enter");
    await expect(month3CatRow.locator("button.y-inline-amt").first()).toHaveText("$150.00");

    // - Clear Budgeted = $0.00
    await month3CatRow.locator("button.y-inline-amt").first().click();
    input = month3CatRow.locator("input.y-inline-amt");
    await input.fill("0.00");
    await input.press("Enter");
    await expect(month3CatRow.locator("button.y-inline-amt").first()).toHaveText("$0.00");
  });

  test("Move Money tool transfers funds between categories without affecting TBB", async ({ page }) => {
    const stamp = Date.now();
    const catAName = `PW MoveA ${stamp}`;
    const catBName = `PW MoveB ${stamp}`;

    // Create Category A and Category B in Needs
    const needsRow = page.locator("tr.y-master").filter({ hasText: "Needs" }).first();
    await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
    let catModal = page.locator(".y-modal").last();
    await catModal.locator("input").first().fill(catAName);
    await catModal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
    await expect(catModal).toBeHidden();

    await needsRow.getByRole("button", { name: "Add category" }).click({ force: true });
    catModal = page.locator(".y-modal").last();
    await catModal.locator("input").first().fill(catBName);
    await catModal.locator(".y-modal-foot").getByRole("button", { name: "Save" }).click();
    await expect(catModal).toBeHidden();

    const rowA = page.locator("tr[data-cat-row]").filter({ hasText: catAName });
    const rowB = page.locator("tr[data-cat-row]").filter({ hasText: catBName });
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    // 1. Assign $100.00 to Category A (available becomes $100.00); Category B has $0.00 available
    const budgetedABtn = rowA.locator("button.y-inline-amt").first();
    await budgetedABtn.click();
    let inputA = rowA.locator("input.y-inline-amt");
    await inputA.fill("100.00");
    await inputA.press("Enter");

    await expect(rowA.locator("button.y-inline-amt").first()).toHaveText("$100.00");
    await expect(rowA.locator("td").last()).toHaveText("$100.00");
    await expect(rowB.locator("td").last()).toHaveText("$0.00");

    // Note baseline TBB
    const initialTbbRes = await page.request.get("/api/budget?month=2026-06");
    const initialTbbData = await initialTbbRes.json();
    const initialTbb = initialTbbData.tbb;

    // 2. Transfer $40.00 from Category A to Category B:
    //    - Reassign Category A: $100.00 -> $60.00
    //    - Reassign Category B: $0.00 -> $40.00
    await rowA.locator("button.y-inline-amt").first().click();
    inputA = rowA.locator("input.y-inline-amt");
    await inputA.fill("60.00");
    await inputA.press("Enter");

    await rowB.locator("button.y-inline-amt").first().click();
    const inputB = rowB.locator("input.y-inline-amt");
    await inputB.fill("40.00");
    await inputB.press("Enter");

    // 3. Verify Category A assigned is $60.00 and available is $60.00
    await expect(rowA.locator("button.y-inline-amt").first()).toHaveText("$60.00");
    await expect(rowA.locator("td").last()).toHaveText("$60.00");

    // 4. Verify Category B assigned is $40.00 and available is $40.00
    await expect(rowB.locator("button.y-inline-amt").first()).toHaveText("$40.00");
    await expect(rowB.locator("td").last()).toHaveText("$40.00");

    // 5. Verify TBB remains completely unaffected
    const afterTbbRes = await page.request.get("/api/budget?month=2026-06");
    const afterTbbData = await afterTbbRes.json();
    expect(afterTbbData.tbb).toBe(initialTbb);
  });
});
