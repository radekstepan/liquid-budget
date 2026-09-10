// apps/web/tests/e2e/transactions-crud-edge-cases.spec.ts
//
// Comprehensive End-to-End Test Suite for Transaction Modification and Edge Cases:
//   1. Changing account on a regular transaction transfers balance between accounts
//   2. Changing category on an expense transaction moves activity between budget categories
//   3. Moving transaction date across month boundaries updates both months' budget activity and TBB
//   4. Editing income transaction from 'Available this month' to 'Available next month' defers TBB
//   5. Editing payee on a single transaction triggers auto-learning of rename rules
//   6. Running balance column accurately reflects chronological balance in account register and shows dash in All Transactions
//
// Skeletons define the exact behavior and verification steps required for 100% transaction modification coverage.

import { test, expect, type Page, type Locator } from "@playwright/test";
import { fillSearchlist, filterRegisterByText } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(
    page.getByText("All Transactions", { exact: true }).first()
  ).toBeVisible();
}

async function gotoBudget(page: Page) {
  await page.getByRole("button", { name: /^Budget/ }).first().click();
  await expect(page.getByTestId("month-nav-picker")).toBeVisible();
}

const MONTH_NUM: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

async function getTbb(page: Page): Promise<number> {
  // The sidebar banner that used to display TBB was removed; read it from
  // the budget-integrity diagnostics API for the currently displayed month
  // (the Month/Year picker reflects it). The API reports cents — convert
  // to dollars to match the old banner text.
  const picker = page.getByTestId("month-nav-picker");
  const monthName = ((await picker.getByRole("button", { name: "Month" }).textContent()) ?? "").trim();
  const year = ((await picker.getByRole("button", { name: "Year" }).textContent()) ?? "").trim();
  const monthNum = MONTH_NUM[monthName];
  expect(monthNum, `unknown month in picker: ${monthName}`).toBeTruthy();
  const res = await page.request.get("/api/diagnostics/budget-integrity", {
    params: { month: `${year}-${monthNum}` },
  });
  expect(res.ok(), "GET /api/diagnostics/budget-integrity").toBe(true);
  const body = await res.json();
  expect(typeof body.tbb, "diagnostics response should include tbb").toBe("number");
  return Number(body.tbb) / 100;
}

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

async function searchRegister(page: Page, text: string) {
  await filterRegisterByText(page, text);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test.describe("Transaction Modification & CRUD Edge Cases", () => {
  test("changing account on a regular transaction transfers balance between accounts", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW ChangeAcc ${stamp}`;

    // 1. Note initial balances of Checking and Cash accounts.
    const initialBudget = await (await page.request.get("/api/budget")).json();
    const tdAccount = initialBudget.accounts.find((a: { name: string }) => a.name === "TD Unlimited Chequing");
    const cashAccount = initialBudget.accounts.find((a: { name: string }) => a.name === "Cash");
    expect(tdAccount).toBeTruthy();
    expect(cashAccount).toBeTruthy();

    const tdInitialBalance = Number(tdAccount.balance);
    const cashInitialBalance = Number(cashAccount.balance);

    // 2. Create a -$60 transaction in TD Unlimited Chequing account.
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const addModal = page.locator(".y-modal").last();
    await expect(addModal.locator(".y-modal-head")).toContainText("Add Transaction");

    await addModal.locator('input[inputmode="decimal"]').first().fill("-60.00");
    await addModal.locator('input[type="date"]').first().fill("2026-06-15");
    await fillSearchlist(addModal, "e.g. Whole Foods", payee);

    await selectOption(addModal, "Account", "TD Unlimited Chequing", page);

    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // Verify TD balance is debited -$60, Cash balance unchanged.
    let budgetAfterAdd = await (await page.request.get("/api/budget")).json();
    let tdAfterAdd = budgetAfterAdd.accounts.find((a: { name: string }) => a.name === "TD Unlimited Chequing");
    let cashAfterAdd = budgetAfterAdd.accounts.find((a: { name: string }) => a.name === "Cash");
    expect(Number(tdAfterAdd.balance)).toBe(tdInitialBalance - 6000);
    expect(Number(cashAfterAdd.balance)).toBe(cashInitialBalance);

    // 3. Open edit modal on the transaction row.
    await searchRegister(page, String(stamp));
    const txRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(txRow).toBeVisible();
    await txRow.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toContainText("Edit Transaction");

    // 4. Change Account select from Checking to Cash. Save changes.
    await selectOption(editModal, "Account", "Cash", page);

    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 5. Verify Checking balance is credited +$60 (restored to original).
    // 6. Verify Cash balance is debited -$60.
    let budgetAfterEdit = await (await page.request.get("/api/budget")).json();
    let tdAfterEdit = budgetAfterEdit.accounts.find((a: { name: string }) => a.name === "TD Unlimited Chequing");
    let cashAfterEdit = budgetAfterEdit.accounts.find((a: { name: string }) => a.name === "Cash");
    expect(Number(tdAfterEdit.balance)).toBe(tdInitialBalance);
    expect(Number(cashAfterEdit.balance)).toBe(cashInitialBalance - 6000);

    // 7. Verify transaction no longer appears in Checking register and appears in Cash register.
    await searchRegister(page, "");
    const tdSidebarBtn = page.getByRole("button", { name: /TD Unlimited Chequing/ }).first();
    await tdSidebarBtn.click();
    await searchRegister(page, String(stamp));
    await expect(page.getByRole("row").filter({ hasText: payee })).toHaveCount(0);

    const cashSidebarBtn = page.getByRole("button", { name: /^Cash/ }).first();
    await cashSidebarBtn.click();
    await searchRegister(page, String(stamp));
    await expect(page.getByRole("row").filter({ hasText: payee }).first()).toBeVisible();
  });

  test("changing category on an expense transaction moves activity between budget categories", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW CatMove ${stamp}`;

    // Ensure we are in Budget view to record baseline for Groceries and Clothing in 1-month view
    await gotoBudget(page);
    const oneMonthBtn = page.getByRole("button", { name: "1 month" });
    if (await oneMonthBtn.isVisible()) {
      await oneMonthBtn.click();
    }

    // Pin June 2026 explicitly: the app opens on the real current month,
    // but this test's transactions are dated in the June seed month.
    const picker = page.getByTestId("month-nav-picker");
    const monthBtn = picker.getByRole("button", { name: "Month" });
    if ((await monthBtn.textContent()) !== "June") {
      await monthBtn.click();
      await page.locator('.y-dropdown [data-value="5"]').click(); // June
    }
    await expect(monthBtn).toHaveText("June");

    const initialTbb = await getTbb(page);

    const groceriesRow = page.locator("tr[data-cat-row]").filter({ hasText: "Groceries" });
    const clothingRow = page.locator("tr[data-cat-row]").filter({ hasText: "Clothing" });

    const parseAmt = (s: string | null) => {
      if (!s) return 0;
      const match = s.replace(/[$,]/g, "").replace(/[−–]/g, "-").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : 0;
    };

    const gOutBefore = parseAmt(await groceriesRow.locator("td").nth(2).textContent());
    const gAvailBefore = parseAmt(await groceriesRow.locator("td").nth(3).textContent());
    const cOutBefore = parseAmt(await clothingRow.locator("td").nth(2).textContent());
    const cAvailBefore = parseAmt(await clothingRow.locator("td").nth(3).textContent());

    // 1. Create a -$75 expense categorized as "Groceries".
    await gotoAllTransactions(page);
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.locator('input[inputmode="decimal"]').first().fill("-75.00");
    await addModal.locator('input[type="date"]').first().fill("2026-06-15");
    await fillSearchlist(addModal, "e.g. Whole Foods", payee);

    await selectOption(addModal, "Category", "Groceries", page);

    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // 3. Open edit modal: change category to "Clothing". Save changes.
    await searchRegister(page, String(stamp));
    const txRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(txRow).toBeVisible();
    await txRow.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toContainText("Edit Transaction");

    await selectOption(editModal, "Category", "Clothing", page);

    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 4. Return to Budget view:
    await gotoBudget(page);

    // Verify Groceries outflow is back to baseline (available restored)
    const groceriesOutflowAfter = await groceriesRow.locator("td").nth(2).textContent();
    const groceriesAvailAfter = await groceriesRow.locator("td").nth(3).textContent();
    expect(parseAmt(groceriesOutflowAfter)).toBeCloseTo(gOutBefore, 2);
    expect(parseAmt(groceriesAvailAfter)).toBeCloseTo(gAvailBefore, 2);

    // Verify Clothing outflow increased by $75 (more negative) and available decreased by $75
    const clothingOutflowAfter = await clothingRow.locator("td").nth(2).textContent();
    const clothingAvailAfter = await clothingRow.locator("td").nth(3).textContent();
    expect(parseAmt(clothingOutflowAfter)).toBeCloseTo(cOutBefore - 75, 2);
    expect(parseAmt(clothingAvailAfter)).toBeCloseTo(cAvailBefore - 75, 2);

    // Verify To Be Budgeted (TBB) remains unchanged
    const tbbAfter = await getTbb(page);
    expect(tbbAfter).toBeCloseTo(initialTbb, 2);
  });

  test("moving transaction date across month boundaries updates both months' budget activity and TBB", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW DateShift ${stamp}`;

    await gotoBudget(page);
    const oneMonthBtn = page.getByRole("button", { name: "1 month" });
    if (await oneMonthBtn.isVisible()) {
      await oneMonthBtn.click();
    }

    const picker = page.getByTestId("month-nav-picker");
    const monthBtn = picker.getByRole("button", { name: "Month" });
    if ((await monthBtn.textContent()) !== "June") {
      await monthBtn.click();
      await page.locator('.y-dropdown [data-value="5"]').click(); // June
    }

    const parseAmt = (s: string | null) => {
      if (!s) return 0;
      const match = s.replace(/[$,]/g, "").replace(/[−–]/g, "-").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : 0;
    };

    const clothingJuneRow = page.locator("tr[data-cat-row]").filter({ hasText: "Clothing" });
    const juneOutflowInitial = parseAmt(await clothingJuneRow.locator("td").nth(2).textContent());

    await page.getByRole("button", { name: "Next month" }).click();
    await expect(monthBtn).toHaveText("July");
    const clothingJulyRow = page.locator("tr[data-cat-row]").filter({ hasText: "Clothing" });
    const julyOutflowInitial = parseAmt(await clothingJulyRow.locator("td").nth(2).textContent());

    // 1. Create a -$120 expense on 2026-06-15 under "Clothing"
    await gotoAllTransactions(page);
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.locator('input[inputmode="decimal"]').first().fill("-120.00");
    await addModal.locator('input[type="date"]').first().fill("2026-06-15");
    await fillSearchlist(addModal, "e.g. Whole Foods", payee);

    await selectOption(addModal, "Category", "Clothing", page);

    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // 2. Edit transaction date to 2026-07-10. Save changes.
    await searchRegister(page, String(stamp));
    const txRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(txRow).toBeVisible();
    await txRow.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toContainText("Edit Transaction");
    await editModal.locator('input[type="date"]').first().fill("2026-07-10");
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 3. Navigate to June Budget: verify Clothing outflow decreased by $120 (restored to initial)
    await gotoBudget(page);
    await monthBtn.click();
    await page.locator('.y-dropdown [data-value="5"]').click(); // June
    await expect(monthBtn).toHaveText("June");
    const juneOutflowAfter = parseAmt(await clothingJuneRow.locator("td").nth(2).textContent());
    expect(juneOutflowAfter).toBeCloseTo(juneOutflowInitial, 2);

    // 4. Navigate to July Budget: verify Clothing outflow increased by $120 (more negative)
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(monthBtn).toHaveText("July");
    const julyOutflowAfter = parseAmt(await clothingJulyRow.locator("td").nth(2).textContent());
    expect(julyOutflowAfter).toBeCloseTo(julyOutflowInitial - 120, 2);

    // 5. Verify row date in account register
    await page.getByRole("button", { name: /TD Unlimited Chequing/ }).first().click();
    await searchRegister(page, String(stamp));
    const shiftedRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(shiftedRow).toBeVisible();
    await expect(shiftedRow).toContainText("2026-07-10");
  });

  test("editing income transaction from 'Available this month' to 'Available next month' defers TBB", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW DeferIncome ${stamp}`;

    await gotoBudget(page);
    const oneMonthBtn = page.getByRole("button", { name: "1 month" });
    if (await oneMonthBtn.isVisible()) {
      await oneMonthBtn.click();
    }

    const picker = page.getByTestId("month-nav-picker");
    const monthBtn = picker.getByRole("button", { name: "Month" });
    if ((await monthBtn.textContent()) !== "June") {
      await monthBtn.click();
      await page.locator('.y-dropdown [data-value="5"]').click(); // June
    }

    const juneTbbInitial = await getTbb(page);

    await page.getByRole("button", { name: "Next month" }).click();
    await expect(monthBtn).toHaveText("July");
    const julyTbbInitial = await getTbb(page);

    // 1. Create +$1,000 Income transaction on 2026-06-01 (Income: Available this month).
    await gotoAllTransactions(page);
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.locator('input[inputmode="decimal"]').first().fill("1000.00");
    await addModal.locator('input[type="date"]').first().fill("2026-06-01");
    await fillSearchlist(addModal, "e.g. Whole Foods", payee);

    await selectOption(addModal, "Category", "Income: Available this month", page);

    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // 2. Verify June TBB increases by +$1,000.
    await gotoBudget(page);
    await monthBtn.click();
    await page.locator('.y-dropdown [data-value="5"]').click(); // June
    await expect(monthBtn).toHaveText("June");
    const juneTbbWithIncome = await getTbb(page);
    expect(juneTbbWithIncome).toBeCloseTo(juneTbbInitial + 1000, 2);

    // 3. Open edit modal: change category to "Income: Available next month" with incomeMonth = "2026-07".
    await gotoAllTransactions(page);
    await searchRegister(page, String(stamp));
    const txRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(txRow).toBeVisible();
    await txRow.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toContainText("Edit Transaction");

    await selectOption(editModal, "Category", "Income: Available next month", page);

    const deferredInput = editModal.locator('input[type="month"]').first();
    await expect(deferredInput).toBeVisible();
    await deferredInput.fill("2026-07");

    // 4. Save changes.
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 5. In June Budget: verify June TBB decreased by $1,000 (restored to initial).
    await gotoBudget(page);
    await monthBtn.click();
    await page.locator('.y-dropdown [data-value="5"]').click(); // June
    await expect(monthBtn).toHaveText("June");
    const juneTbbAfterDeferred = await getTbb(page);
    expect(juneTbbAfterDeferred).toBeCloseTo(juneTbbInitial, 2);

    // 6. In July Budget: verify July TBB increased by +$1,000 (deferred income received).
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(monthBtn).toHaveText("July");
    const julyTbbAfterDeferred = await getTbb(page);
    expect(julyTbbAfterDeferred).toBeCloseTo(julyTbbInitial + 1000, 2);
  });

  test("editing payee on a single transaction triggers auto-learning of rename rules", async ({ page }) => {
    const stamp = Date.now();
    const rawPayee = `SHELL OIL #${stamp}`;
    const cleanPayee = `Shell ${stamp}`;

    // 1. Create a transaction with raw imported payee "SHELL OIL #...".
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.locator('input[inputmode="decimal"]').first().fill("-45.00");
    await addModal.locator('input[type="date"]').first().fill("2026-06-15");
    await fillSearchlist(addModal, "e.g. Whole Foods", rawPayee);
    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // 2. Open edit modal: rename payee to "Shell ...". Save changes.
    await searchRegister(page, String(stamp));
    const txRow = page.getByRole("row").filter({ hasText: rawPayee }).first();
    await expect(txRow).toBeVisible();
    await txRow.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toContainText("Edit Transaction");

    await fillSearchlist(editModal, "e.g. Whole Foods", cleanPayee);
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 3. Verify GET /api/rename-rules contains an auto-learned rule mapping rawPayee -> cleanPayee.
    const rules = await (await page.request.get("/api/rename-rules")).json();
    const learnedRule = rules.find((r: { sourcePattern: string }) => r.sourcePattern === rawPayee);
    expect(learnedRule).toBeTruthy();
    expect(learnedRule.targetPayee).toBe(cleanPayee);

    // 4. In Settings -> Rename Rules, verify the rule is displayed.
    await page.getByRole("button", { name: /^settings$/i }).first().click();
    await page.getByText("Rename Rules").click();
    await expect(page.getByText("Payee Rename Rules")).toBeVisible();
    const ruleRow = page.locator("table.y-table tbody tr.y-row").filter({ hasText: rawPayee });
    await expect(ruleRow).toBeVisible();
    await expect(ruleRow.locator("td").nth(0)).toHaveText(rawPayee);
    await expect(ruleRow.locator("td").nth(1)).toHaveText(cleanPayee);
  });

  test("running balance column accurately reflects chronological balance in account register and shows dash in All Transactions", async ({ page }) => {
    const stamp = Date.now();
    const accName = `PW RunBal Acc ${stamp}`;
    const payee1 = `AAA RunBal1 ${stamp}`;
    const payee2 = `BBB RunBal2 ${stamp}`;
    const payee3 = `CCC RunBal3 ${stamp}`;

    // 1. Create a dedicated account with $0 starting balance for exact running balance assertions
    const res = await page.request.post("/api/accounts", {
      data: { name: accName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    expect(res.ok()).toBeTruthy();

    // Reload page to pick up new account
    await page.reload();
    await waitForReady(page);
    await gotoAllTransactions(page);

    // 2. Create 3 transactions with dates: 2026-06-01 (+$1000), 2026-06-05 (-$200), 2026-06-10 (-$300)
    const txConfigs = [
      { payee: payee1, amount: "1000.00", date: "2026-06-01" },
      { payee: payee2, amount: "-200.00", date: "2026-06-05" },
      { payee: payee3, amount: "-300.00", date: "2026-06-10" },
    ];

    for (const cfg of txConfigs) {
      await page.getByRole("button", { name: /Add.*Transaction/i }).click();
      const modal = page.locator(".y-modal").last();
      await modal.locator('input[inputmode="decimal"]').first().fill(cfg.amount);
      await modal.locator('input[type="date"]').first().fill(cfg.date);
      await fillSearchlist(modal, "e.g. Whole Foods", cfg.payee);

      await selectOption(modal, "Account", accName, page);

      await modal.getByRole("button", { name: "Save Transaction" }).click();
      await expect(modal).toBeHidden();
    }

    // Filter register by the single account
    const accountRow = page.getByRole("button", { name: new RegExp(accName) }).first();
    await accountRow.click();

    // 3. Verify running balance column displays $1,000.00, $800.00, and $500.00 respectively
    // Default sort is Date desc: Row 1 (2026-06-10, -$300) -> $500.00, Row 2 (2026-06-05, -$200) -> $800.00, Row 3 (2026-06-01, +$1000) -> $1,000.00
    const row10 = page.getByRole("row").filter({ hasText: payee3 }).first();
    const row05 = page.getByRole("row").filter({ hasText: payee2 }).first();
    const row01 = page.getByRole("row").filter({ hasText: payee1 }).first();

    await expect(row10).toBeVisible();
    await expect(row05).toBeVisible();
    await expect(row01).toBeVisible();

    await expect(row10.locator("td.y-num").last()).toHaveText("$500.00");
    await expect(row05.locator("td.y-num").last()).toHaveText("$800.00");
    await expect(row01.locator("td.y-num").last()).toHaveText("$1,000.00");

    // 4. Click "Transactions" in sidebar to switch to All Transactions view.
    await page.getByRole("button", { name: /^Transactions/ }).click();
    await expect(page.getByText("All Transactions", { exact: true }).first()).toBeVisible();

    // 5. Switch back to account view and sort table by Payee: verify running balance values stay anchored to chronological dates.
    await accountRow.click();

    const register = page.locator("table.y-table:not(.y-scheduled-table)");
    const payeeTh = register.locator("thead th").filter({ hasText: "Payee" });
    await payeeTh.locator("button").click(); // Ascending: AAA, BBB, CCC

    // Payee asc: AAA (June 1) is first row -> $1,000.00; BBB (June 5) is second -> $800.00; CCC (June 10) is third -> $500.00
    const sortedRows = register.locator("tbody tr.y-row");
    await expect(sortedRows.nth(0)).toContainText(payee1);
    await expect(sortedRows.nth(0).locator("td.y-num").last()).toHaveText("$1,000.00");

    await expect(sortedRows.nth(1)).toContainText(payee2);
    await expect(sortedRows.nth(1).locator("td.y-num").last()).toHaveText("$800.00");

    await expect(sortedRows.nth(2)).toContainText(payee3);
    await expect(sortedRows.nth(2).locator("td.y-num").last()).toHaveText("$500.00");
  });
});

