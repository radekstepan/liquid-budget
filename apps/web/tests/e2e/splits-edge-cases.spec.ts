// apps/web/tests/e2e/splits-edge-cases.spec.ts
//
// Comprehensive End-to-End Test Suite for Split Transaction Edge Cases:
//   1. Modifying an existing split transaction updates sub-transaction amounts and recalculates parent total
//   2. Adding and removing sub-transaction rows in the split editor maintains balancing constraints
//   3. Converting a single transaction into a split transaction reverses single balance and creates split children
//   4. Deleting one child of a 2-way split automatically flattens the remaining child into a standalone transaction
//   5. Deleting one child of a 3-way split reduces parent total and reverses only that child's balance
//   6. Mixed-sign split transactions (Paycheck with deductions) correctly apply income and expense legs
//   7. Split transaction containing transfer sub-transactions updates remote account balances
//   8. Split sub-transaction with custom payee override persists independently of parent payee
//   9. Searching register for a split child memo or payee automatically expands the split parent
//
// Skeletons define the exact behavior and verification steps required for 100% split coverage.

import { test, expect, type Page } from "@playwright/test";
import { computeBudget, num, type BudgetData } from "@ynab/logic";
import { fillSearchlist, openSearchField, pickSubCategory, filterRegisterByText, clearRegisterFilter } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

async function gotoAllTransactions(page: Page) {
  await page.getByRole("button", { name: /^Transactions/ }).click();
  await expect(
    page.getByText("All Transactions", { exact: true }).first()
  ).toBeVisible();
}

async function getBudgetData(page: Page): Promise<BudgetData> {
  const res = await page.request.get("/api/budget");
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as BudgetData;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test.describe("Split Transaction Edge Cases", () => {
  test("modifying an existing split transaction updates sub-transaction amounts and recalculates parent total", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW ModSplit ${stamp}`;

    // 1. Create a 2-way split (-$100 = -$60 Groceries + -$40 Household).
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const addModal = page.locator(".y-modal").last();
    await expect(addModal.locator(".y-modal-head")).toContainText("Add Transaction");

    // Switch to Split mode
    await addModal.getByRole("button", { name: /^split$/i }).click();

    // Set parent details
    await fillSearchlist(addModal, "e.g. Whole Foods", payee);
    await addModal.locator('input[type="date"]').first().fill("2026-06-15");
    const allDecimals = addModal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("-100.00");

    // Pick categories for the two sub-rows
    await pickSubCategory(addModal, page, "Groceries");
    await pickSubCategory(addModal, page, "Household");

    // Set sub-row amounts
    await allDecimals.nth(1).fill("-60.00");
    await allDecimals.nth(2).fill("-40.00");

    // Save
    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // 2. Open edit modal by clicking the split parent row.
    await filterRegisterByText(page, payee);
    const parentRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(parentRow).toBeVisible();
    await parentRow.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toContainText("Edit Transaction");

    // 3. Verify sub-transactions are pre-filled with -$60 and -$40.
    const editDecimals = editModal.locator('input[inputmode="decimal"]');
    await expect(editDecimals.nth(0)).toHaveValue("-100.00");
    await expect(editDecimals.nth(1)).toHaveValue("-60.00");
    await expect(editDecimals.nth(2)).toHaveValue("-40.00");

    // 4. Update sub-row 1 to -$70 and sub-row 2 to -$50, updating parent amount to -$120.
    await editDecimals.nth(1).fill("-70.00");
    await editDecimals.nth(2).fill("-50.00");
    await editDecimals.nth(0).fill("-120.00");

    // 5. Save changes.
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 6. Verify parent row reflects -$120 in register.
    await expect(parentRow).toContainText("$120.00");

    // 7. Verify /api/budget returns updated subtransactions (-$70 and -$50).
    const budgetData = await getBudgetData(page);
    const parentTx = budgetData.transactions.find((t) => t.payee === payee && t.parentId == null);
    expect(parentTx).toBeDefined();
    expect(num(parentTx!.amount)).toBe(-12000);

    const children = budgetData.transactions.filter((t) => t.parentId === parentTx!.id);
    expect(children).toHaveLength(2);
    const childAmounts = children.map((c) => num(c.amount)).sort((a, b) => a - b);
    expect(childAmounts).toEqual([-7000, -5000]);

    // 8. Verify category activity in budget reflects -$70 for Groceries and -$50 for Household.
    const budgetMonth = computeBudget(budgetData, "2026-06");
    const allCatRows = budgetMonth.groups.flatMap((g) => g.rows);
    const grocCat = allCatRows.find((r) => r.category.name === "Groceries");
    const houseCat = allCatRows.find((r) => r.category.name === "Household");
    expect(grocCat).toBeDefined();
    expect(houseCat).toBeDefined();
    expect(grocCat!.outflow).toBeLessThanOrEqual(-70);
    expect(houseCat!.outflow).toBeLessThanOrEqual(-50);
  });

  test("adding and removing sub-transaction rows in the split editor maintains balancing constraints", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW AddRemSplit ${stamp}`;

    // 1. Open Add Transaction modal in Split mode.
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^split$/i }).click();

    // 2. Set total amount to -$100.
    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    const allDecimals = modal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("-100.00");

    // 3. Click "+ Add sub-transaction" to create a 3rd sub-row.
    await modal.getByRole("button", { name: "+ Add sub-transaction" }).click();
    const subRows = modal.locator('[class*="space-y-1.5"] > div');
    await expect(subRows).toHaveCount(3);

    // 4. Set sub-row 1 = -$50 (Groceries), sub-row 2 = -$25 (Household), sub-row 3 = -$25 (Rent).
    await pickSubCategory(modal, page, "Groceries");
    await pickSubCategory(modal, page, "Household");
    await pickSubCategory(modal, page, "Rent");

    await allDecimals.nth(1).fill("-50.00");
    await allDecimals.nth(2).fill("-25.00");
    await allDecimals.nth(3).fill("-25.00");

    const saveBtn = modal.getByRole("button", { name: "Save Transaction" });
    await expect(saveBtn).toBeEnabled();

    // 5. Click remove (x) on sub-row 2 -> verify subRows decreases to 2 rows.
    const removeButtons = modal.locator('button[aria-label="Remove sub-transaction"]');
    await removeButtons.nth(1).click();
    await expect(subRows).toHaveCount(2);

    // 6. Verify Save button is disabled because -$50 + -$25 != -$100.
    await expect(saveBtn).toBeDisabled();

    // 7. Adjust sub-row 1 to -$75 -> verify Save button is enabled (sum matches parent).
    await allDecimals.nth(1).fill("-75.00");
    await expect(saveBtn).toBeEnabled();

    // 8. Save and verify exactly 2 sub-transactions are persisted.
    await saveBtn.click();
    await expect(modal).toBeHidden();

    const budgetData = await getBudgetData(page);
    const parentTx = budgetData.transactions.find((t) => t.payee === payee && t.parentId == null);
    expect(parentTx).toBeDefined();
    expect(num(parentTx!.amount)).toBe(-10000);

    const children = budgetData.transactions.filter((t) => t.parentId === parentTx!.id);
    expect(children).toHaveLength(2);
    const childAmounts = children.map((c) => num(c.amount)).sort((a, b) => a - b);
    expect(childAmounts).toEqual([-7500, -2500]);
  });

  test("converting a single transaction into a split transaction reverses single balance and creates split children", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW ConvertSplit ${stamp}`;

    // 1. Create a single transaction (-$80 on Groceries).
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.locator('input[inputmode="decimal"]').first().fill("-80.00");
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    await fillSearchlist(modal, "e.g. Whole Foods", payee);

    const catInput = await openSearchField(modal, "Income: Available this month");
    await catInput.fill("Groceries");
    await page.locator('.y-dropdown button[role="option"]').filter({ hasText: "Groceries" }).click();

    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();

    // 2. Note starting account balance and Groceries category activity.
    const initialData = await getBudgetData(page);
    const initialChecking = initialData.accounts.find((a) => a.id === 1)!;
    const initialCheckingBal = num(initialChecking.balance);

    // 3. Click row to open edit modal, switch segmented toggle from "Single" to "Split".
    await filterRegisterByText(page, payee);
    const row = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(row).toBeVisible();
    await row.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toContainText("Edit Transaction");
    await editModal.getByRole("button", { name: "Split", exact: true }).click();

    // 4. Assign sub-row 1 = -$50 (Groceries) and sub-row 2 = -$30 (Dental, Optical, Counselling).
    const subRows = editModal.locator('[class*="space-y-1.5"] > div');
    await expect(subRows).toHaveCount(2);

    await subRows.nth(0).locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: "Groceries", exact: true }).click();

    await subRows.nth(1).locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: "Dental, Optical, Counselling", exact: true }).click();

    const allDecimals = editModal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(1).fill("-50.00");
    await allDecimals.nth(2).fill("-30.00");

    // 5. Save transaction.
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 6. Verify register row changes from "Groceries" category to "Split (Multiple Categories)".
    await expect(row).toContainText("Split (Multiple Categories)");

    // 7. Verify account balance remains unchanged (-$80 net).
    const afterData = await getBudgetData(page);
    const afterChecking = afterData.accounts.find((a) => a.id === 1)!;
    expect(num(afterChecking.balance)).toBe(initialCheckingBal);

    // 8. Verify Groceries activity changes to -$50 and Medical/Dental activity becomes -$30.
    const convertedParent = afterData.transactions.find((t) => t.payee === payee && t.parentId == null);
    expect(convertedParent).toBeDefined();
    const children = afterData.transactions.filter((t) => t.parentId === convertedParent!.id);
    expect(children).toHaveLength(2);
    expect(children.map((c) => num(c.amount)).sort((a, b) => a - b)).toEqual([-5000, -3000]);
  });

  test("deleting one child of a 2-way split automatically flattens the remaining child into a standalone transaction", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW FlattenSplit ${stamp}`;

    // 1. Create a 2-way split: Parent = -$60, Child 1 = -$40 (Groceries), Child 2 = -$20 (Rent).
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^split$/i }).click();

    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    const allDecimals = modal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("-60.00");

    await pickSubCategory(modal, page, "Groceries");
    await pickSubCategory(modal, page, "Rent");

    await allDecimals.nth(1).fill("-40.00");
    await allDecimals.nth(2).fill("-20.00");

    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();

    // 2. Note account balance and register rows.
    const beforeData = await getBudgetData(page);
    const parentTx = beforeData.transactions.find((t) => t.payee === payee && t.parentId == null)!;
    const initialChildren = beforeData.transactions.filter((t) => t.parentId === parentTx.id);
    expect(initialChildren).toHaveLength(2);

    const grocChild = initialChildren.find((c) => num(c.amount) === -4000)!;
    const rentChild = initialChildren.find((c) => num(c.amount) === -2000)!;
    expect(grocChild).toBeDefined();
    expect(rentChild).toBeDefined();

    const checkingBefore = num(beforeData.accounts.find((a) => a.id === parentTx.accountId)!.balance);

    // 3. Delete Child 1 via API.
    const delRes = await page.request.delete(`/api/transactions?id=${grocChild.id}`);
    expect(delRes.ok()).toBeTruthy();

    // 4. Verify parent row is deleted from the database.
    const afterData = await getBudgetData(page);
    const oldParent = afterData.transactions.find((t) => t.id === parentTx.id);
    expect(oldParent).toBeUndefined();

    // 5. Verify Child 2 is updated to have parentId = null and becomes a standalone transaction.
    const flattenedChild = afterData.transactions.find((t) => t.id === rentChild.id);
    expect(flattenedChild).toBeDefined();
    expect(flattenedChild!.parentId).toBeNull();
    expect(num(flattenedChild!.amount)).toBe(-2000);
    expect(flattenedChild!.categoryId).toBe(rentChild.categoryId);

    // 6. Verify register displays a single -$20 Rent transaction.
    await page.reload();
    await waitForReady(page);
    await gotoAllTransactions(page);
    await filterRegisterByText(page, payee);

    const standaloneRow = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(standaloneRow).toBeVisible();
    await expect(standaloneRow).toContainText("Rent");
    await expect(standaloneRow).toContainText("$20.00");

    // 7. Verify account balance is credited +$40 (net effect is now only -$20).
    const checkingAfter = num(afterData.accounts.find((a) => a.id === parentTx.accountId)!.balance);
    expect(checkingAfter).toBe(checkingBefore + 4000);
  });

  test("deleting one child of a 3-way split reduces parent total and reverses only that child's balance", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW 3WaySplit ${stamp}`;

    // 1. Create a 3-way split: Parent = -$100, Child 1 = -$50, Child 2 = -$30, Child 3 = -$20.
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^split$/i }).click();

    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    const allDecimals = modal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("-100.00");

    await modal.getByRole("button", { name: "+ Add sub-transaction" }).click();

    await pickSubCategory(modal, page, "Groceries");
    await pickSubCategory(modal, page, "Household");
    await pickSubCategory(modal, page, "Rent");

    await allDecimals.nth(1).fill("-50.00");
    await allDecimals.nth(2).fill("-30.00");
    await allDecimals.nth(3).fill("-20.00");

    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();

    const beforeData = await getBudgetData(page);
    const parentTx = beforeData.transactions.find((t) => t.payee === payee && t.parentId == null)!;
    const initialChildren = beforeData.transactions.filter((t) => t.parentId === parentTx.id);
    expect(initialChildren).toHaveLength(3);

    const child3 = initialChildren.find((c) => num(c.amount) === -2000)!;
    expect(child3).toBeDefined();

    const checkingBefore = num(beforeData.accounts.find((a) => a.id === parentTx.accountId)!.balance);

    // 2. Delete Child 3 via API.
    const delRes = await page.request.delete(`/api/transactions?id=${child3.id}`);
    expect(delRes.ok()).toBeTruthy();

    // 3. Verify parent row amount automatically updates from -$100 to -$80.
    const afterData = await getBudgetData(page);
    const updatedParent = afterData.transactions.find((t) => t.id === parentTx.id);
    expect(updatedParent).toBeDefined();
    expect(num(updatedParent!.amount)).toBe(-8000);

    // 4. Verify Child 1 and Child 2 remain linked to the parent.
    const remainingChildren = afterData.transactions.filter((t) => t.parentId === parentTx.id);
    expect(remainingChildren).toHaveLength(2);
    const remainingAmounts = remainingChildren.map((c) => num(c.amount)).sort((a, b) => a - b);
    expect(remainingAmounts).toEqual([-5000, -3000]);

    // 5. Verify account balance is credited +$20.
    const checkingAfter = num(afterData.accounts.find((a) => a.id === parentTx.accountId)!.balance);
    expect(checkingAfter).toBe(checkingBefore + 2000);
  });

  test("mixed-sign split transactions (Paycheck with deductions) correctly apply income and expense legs", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW Paycheck ${stamp}`;

    const beforeData = await getBudgetData(page);
    const checkingBefore = num(beforeData.accounts.find((a) => a.id === 1)!.balance);
    const budgetMonthBefore = computeBudget(beforeData, "2026-06");
    const tbbBefore = budgetMonthBefore.tbb;

    // 1. Open Add Transaction modal in Split mode with parent amount = +$3,000 (Paycheck net deposit).
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^split$/i }).click();

    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[type="date"]').first().fill("2026-06-01");
    const allDecimals = modal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("3000.00");

    // Add 3rd sub-row
    await modal.getByRole("button", { name: "+ Add sub-transaction" }).click();
    const subRows = modal.locator('[class*="space-y-1.5"] > div');
    await expect(subRows).toHaveCount(3);

    // 2. Sub-row 1: Inflow +$3,600 (Income: unselected category with positive inflow is Income).
    await allDecimals.nth(1).fill("3600.00");

    // 3. Sub-row 2: Outflow -$500 (Household category).
    await subRows.nth(1).locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: "Household", exact: true }).click();
    await allDecimals.nth(2).fill("-500.00");

    // 4. Sub-row 3: Outflow -$100 (Rent category).
    await subRows.nth(2).locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: "Rent", exact: true }).click();
    await allDecimals.nth(3).fill("-100.00");

    // 5. Verify Σ footer balances (+3600 - 500 - 100 = +3000) and Save is enabled.
    const saveBtn = modal.getByRole("button", { name: "Save Transaction" });
    await expect(saveBtn).toBeEnabled();

    // 6. Save transaction.
    await saveBtn.click();
    await expect(modal).toBeHidden();

    // 7. Verify Checking account balance increases by +$3,000.
    const afterData = await getBudgetData(page);
    const checkingAfter = num(afterData.accounts.find((a) => a.id === 1)!.balance);
    expect(checkingAfter).toBe(checkingBefore + 300000);

    // 8. Verify To Be Budgeted (TBB) increases by +$3,600.
    const budgetMonthAfter = computeBudget(afterData, "2026-06");
    expect(budgetMonthAfter.tbb).toBeCloseTo(tbbBefore + 360000, 1);

    // 9. Verify category outflows reflect the split legs.
    const parentTx = afterData.transactions.find((t) => t.payee === payee && t.parentId == null)!;
    expect(parentTx).toBeDefined();
    const children = afterData.transactions.filter((t) => t.parentId === parentTx.id);
    expect(children).toHaveLength(3);

    const incomeChild = children.find((c) => num(c.amount) === 360000);
    const houseChild = children.find((c) => num(c.amount) === -50000);
    const rentChild = children.find((c) => num(c.amount) === -10000);

    expect(incomeChild).toBeDefined();
    expect(incomeChild!.isIncome).toBe(true);
    expect(houseChild).toBeDefined();
    expect(rentChild).toBeDefined();
  });

  test("split transaction containing transfer sub-transactions updates remote account balances", async ({ page }) => {
    const stamp = Date.now();
    const payee = `PW SplitTransfer ${stamp}`;

    const beforeData = await getBudgetData(page);
    const checkingBefore = num(beforeData.accounts.find((a) => a.id === 1)!.balance);
    const eqBankBefore = num(beforeData.accounts.find((a) => a.id === 2)!.balance);

    // 1. Create a split transaction on Checking with total -$200:
    //    - Sub-row 1: -$120 Category = Groceries
    //    - Sub-row 2: -$80 Transfer to = EQ Bank (Savings)
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^split$/i }).click();

    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    const allDecimals = modal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("-200.00");

    await pickSubCategory(modal, page, "Groceries");
    await pickSubCategory(modal, page, "Transfer : EQ Bank");

    await allDecimals.nth(1).fill("-120.00");
    await allDecimals.nth(2).fill("-80.00");

    // 2. Save transaction.
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();

    // 3. Verify Checking balance decreases by $200.
    const afterData = await getBudgetData(page);
    const checkingAfter = num(afterData.accounts.find((a) => a.id === 1)!.balance);
    expect(checkingAfter).toBe(checkingBefore - 20000);

    // 4. Verify EQ Bank balance increases by $80.
    const eqBankAfter = num(afterData.accounts.find((a) => a.id === 2)!.balance);
    expect(eqBankAfter).toBe(eqBankBefore + 8000);

    // 5. Verify Groceries category outflow is -$120.
    const parentTx = afterData.transactions.find((t) => t.payee === payee && t.parentId == null)!;
    const children = afterData.transactions.filter((t) => t.parentId === parentTx.id);
    expect(children).toHaveLength(2);
    const grocChild = children.find((c) => num(c.amount) === -12000);
    const transferChild = children.find((c) => num(c.amount) === -8000);
    expect(grocChild).toBeDefined();
    expect(transferChild).toBeDefined();
    expect(transferChild!.transferAccountId).toBe(2);

    // 6. Navigate to EQ Bank register and verify the incoming +$80 transfer leg is present.
    const eqRow = page.getByRole("button", { name: /EQ Bank/ }).first();
    await eqRow.click();
    await expect(page.locator(".y-toolbar").getByText("EQ Bank", { exact: true })).toBeVisible();

    const transferRow = page
      .getByRole("row")
      .filter({ hasText: "Transfer : TD Unlimited Chequing" })
      .filter({ hasText: "$80.00" })
      .first();
    await expect(transferRow).toBeVisible();
    await expect(transferRow).toContainText("$80.00");
  });

  test("split sub-transaction with custom payee override persists independently of parent payee", async ({ page }) => {
    const stamp = Date.now();
    const parentPayee = `PW Costco Wholesale ${stamp}`;
    const editedParentPayee = `PW Costco Warehouse ${stamp}`;
    const subPayee1 = `Costco Gas ${stamp}`;
    const subPayee2 = `Costco Pharmacy ${stamp}`;

    // 1. Create a split transaction with parent payee "Costco Wholesale" and custom sub-payees.
    const createRes = await page.request.post("/api/transactions", {
      data: {
        accountId: 1,
        date: "2026-06-15",
        payee: parentPayee,
        amount: -7000,
        subTransactions: [
          { amount: -4500, categoryId: 11, payee: subPayee1, memo: "Fuel" },
          { amount: -2500, categoryId: 10, payee: subPayee2, memo: "Medicine" },
        ],
      },
    });
    expect(createRes.ok()).toBeTruthy();

    await page.reload();
    await waitForReady(page);
    await gotoAllTransactions(page);

    // 2. Locate the parent row in register and verify custom sub-payees in DB.
    const budgetBefore = await getBudgetData(page);
    const createdParent = budgetBefore.transactions.find((t) => t.payee === parentPayee && t.parentId == null)!;
    expect(createdParent).toBeDefined();
    const createdChildren = budgetBefore.transactions.filter((t) => t.parentId === createdParent.id);
    expect(createdChildren).toHaveLength(2);
    const initialPayees = createdChildren.map((c) => c.payee).sort();
    expect(initialPayees).toEqual([subPayee1, subPayee2].sort());

    // 3. Open edit modal by clicking the parent row.
    await filterRegisterByText(page, parentPayee);
    const parentRow = page.getByRole("row").filter({ hasText: parentPayee }).first();
    await expect(parentRow).toBeVisible();
    await parentRow.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.getByText("Edit Transaction")).toBeVisible();

    // 4. Edit parent payee to "Costco Warehouse".
    await fillSearchlist(editModal, "e.g. Whole Foods", editedParentPayee);

    // 5. Save changes.
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 6. Verify sub-transactions retain their distinct custom payees ("Costco Gas" and "Costco Pharmacy").
    const budgetAfter = await getBudgetData(page);
    const updatedParent = budgetAfter.transactions.find((t) => t.payee === editedParentPayee && t.parentId == null);
    expect(updatedParent).toBeDefined();

    const updatedChildren = budgetAfter.transactions.filter((t) => t.parentId === updatedParent!.id);
    expect(updatedChildren).toHaveLength(2);
    const payees = updatedChildren.map((c) => c.payee).sort();
    expect(payees).toEqual([subPayee1, subPayee2].sort());
  });

  test("searching register for a split child memo or payee automatically expands the split parent", async ({ page }) => {
    const stamp = Date.now();
    const uniqueMemo = `SecretGiftItem${stamp}`;
    const payee = `PW Supermarket Split ${stamp}`;

    // 1. Create a split parent with unique payee "Supermarket Split" and child memo "SecretGiftItem".
    await page.getByRole("button", { name: /Add.*Transaction/i }).click();
    const modal = page.locator(".y-modal").last();
    await modal.getByRole("button", { name: /^split$/i }).click();

    await fillSearchlist(modal, "e.g. Whole Foods", payee);
    await modal.locator('input[type="date"]').first().fill("2026-06-15");
    const allDecimals = modal.locator('input[inputmode="decimal"]');
    await allDecimals.nth(0).fill("-60.00");

    await pickSubCategory(modal, page, "Groceries");
    await pickSubCategory(modal, page, "Household");

    await allDecimals.nth(1).fill("-40.00");
    await allDecimals.nth(2).fill("-20.00");

    // Add memo to child 1
    const memoInputs = modal.locator('input[aria-label^="Sub-transaction"][aria-label$="memo"]');
    await memoInputs.nth(0).fill(uniqueMemo);

    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(modal).toBeHidden();

    // Verify parent row is rendered collapsed (no child row visible by default)
    const childGlyphRows = page.locator("tbody tr.y-subrow", { hasText: "↳" });
    const initialSubrowCount = await childGlyphRows.filter({ hasText: uniqueMemo }).count();
    expect(initialSubrowCount).toBe(0);

    // 2. Filter the register for the child memo via the search modal.
    await filterRegisterByText(page, uniqueMemo);

    // 3. Verify the split parent row is displayed.
    const matchingParent = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(matchingParent).toBeVisible();

    // 4. Verify the split parent is automatically expanded in the table showing the child row with memo "SecretGiftItem".
    const matchingChildRow = page.locator("tbody tr.y-subrow").filter({ hasText: uniqueMemo });
    await expect(matchingChildRow).toBeVisible();
    await expect(matchingChildRow).toContainText("↳");
    await expect(matchingChildRow).toContainText(uniqueMemo);

    // 5. Clear the filter and verify register restores normal collapsed state.
    await clearRegisterFilter(page);
    await expect(matchingChildRow).toBeHidden();
  });
});

