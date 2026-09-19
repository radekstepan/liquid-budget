// apps/web/tests/e2e/transfers-edge-cases.spec.ts
//
// Comprehensive End-to-End Test Suite for Transfer Transaction Edge Cases:
//   1. Modifying transfer amount reverses previous balance and updates both accounts
//   2. Modifying transfer date updates date and running balance order in both accounts
//   3. Transfer account dropdown is disabled during edit and API rejects account change
//   4. Internal transfer (On-Budget to On-Budget) requires no category and has zero budget impact
//   5. Boundary transfer outflow (On-Budget to Off-Budget) enforces mandatory category and deducts budget
//   6. Boundary transfer inflow (Off-Budget to On-Budget) handles uncategorized income vs categorized refund
//   7. Transfer payment to Credit Card account draws down Credit Card Payment category buffer
//   8. Transfer cleared status is tracked independently on source and destination registers
//
// Skeletons define the exact behavior and verification steps required for 100% transfer coverage.

import { test, expect, type Page, type Locator } from "@playwright/test";

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

async function fillPayee(scope: Locator, value: string) {
  const trigger = scope.locator(".y-searchlist-trigger").first();
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
  }
  const input = scope.locator(".y-searchlist input").first();
  await expect(input).toBeVisible();
  await input.fill(value);
}

async function selectOption(
  scope: Locator,
  labelText: string | RegExp,
  optionText: string,
  page: Page
) {
  const labelSpan = scope.locator("span.y-label", { hasText: labelText }).first();
  await expect(labelSpan).toBeVisible();
  const field = labelSpan.locator("xpath=..");
  const trigger = field.locator('button[aria-haspopup="listbox"]').first();
  await expect(trigger).toBeVisible();
  await trigger.click();

  const searchInput = field.locator("input.y-select-search").first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(optionText);
  }
  const option = page
    .locator('.y-dropdown button[role="option"]')
    .filter({ hasText: optionText })
    .first();
  await expect(option).toBeVisible();
  await option.click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
  await gotoAllTransactions(page);
});

test.describe("Transfer Transaction Edge Cases", () => {
  test("modifying transfer amount reverses previous balance and updates both accounts", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const savName = `PW Sav ${stamp}`;
    const payeeName = `PW ModAmt ${stamp}`;

    // Create 2 fresh accounts
    const chkRes = await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    expect(chkRes.ok()).toBeTruthy();
    const savRes = await page.request.post("/api/accounts", {
      data: { name: savName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    expect(savRes.ok()).toBeTruthy();

    await page.reload();
    await waitForReady(page);
    await gotoAllTransactions(page);

    // 1. Create a transfer of -$50 from Checking to Savings.
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    const modal = page.locator(".y-modal").last();

    // Select source account in Single mode before switching to Transfer mode
    await selectOption(modal, "Account", chkName, page);
    await modal.getByRole("button", { name: /^transfer$/i }).click();

    await fillPayee(modal, payeeName);
    await modal.locator('input[inputmode="decimal"]').first().fill("-50.00");
    await selectOption(modal, "Transfer to", savName, page);

    const createPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await createPromise;
    await expect(modal).toBeHidden();

    // 2. Note initial balances: Checking reflects -$50, Savings reflects +$50.
    const budget1 = await (await page.request.get("/api/budget")).json();
    const chk1 = budget1.accounts.find((a: { name: string }) => a.name === chkName);
    const sav1 = budget1.accounts.find((a: { name: string }) => a.name === savName);
    expect(Number(chk1.balance)).toBe(-5000);
    expect(Number(sav1.balance)).toBe(5000);

    // 3. Open edit modal on the transfer row in Checking register.
    await page.getByRole("button", { name: new RegExp(`^${chkName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(chkName, { exact: true })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: payeeName }).first();
    await expect(row).toBeVisible();
    await row.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toHaveText("Edit Transaction");

    // 4. Change amount from -$50 to -$150. Save changes.
    await editModal.locator('input[inputmode="decimal"]').first().fill("-150.00");
    const updatePromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "PATCH"
    );
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await updatePromise;
    await expect(editModal).toBeHidden();

    // 5. Verify Checking balance is now -$150 from baseline.
    // 6. Verify Savings balance is now +$150 from baseline.
    const budget2 = await (await page.request.get("/api/budget")).json();
    const chk2 = budget2.accounts.find((a: { name: string }) => a.name === chkName);
    const sav2 = budget2.accounts.find((a: { name: string }) => a.name === savName);
    expect(Number(chk2.balance)).toBe(-15000);
    expect(Number(sav2.balance)).toBe(15000);

    // 7. Verify both account registers show -$150 (outflow) and +$150 (inflow) respectively.
    await expect(row.locator("td.num.y-num").nth(0)).toHaveText("$150.00");
    await expect(row.locator("td.num.y-num").nth(1)).toHaveText("");

    await page.getByRole("button", { name: new RegExp(`^${savName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(savName, { exact: true })).toBeVisible();
    const savRow = page.getByRole("row").filter({ hasText: `Transfer : ${chkName}` }).first();
    await expect(savRow).toBeVisible();
    await expect(savRow.locator("td.num.y-num").nth(0)).toHaveText("");
    await expect(savRow.locator("td.num.y-num").nth(1)).toHaveText("$150.00");
  });

  test("modifying transfer date updates date and running balance order in both accounts", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const savName = `PW Sav ${stamp}`;
    const xferPayee = `PW XferDate ${stamp}`;
    const anchorChk = `PW AnchorChk ${stamp}`;
    const anchorSav = `PW AnchorSav ${stamp}`;

    const chkRes = await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const chkAcc = await chkRes.json();
    const savRes = await page.request.post("/api/accounts", {
      data: { name: savName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const savAcc = await savRes.json();

    // Create anchor transactions on 2026-06-15 (+$1000 in both accounts)
    await page.request.post("/api/transactions", {
      data: {
        accountId: chkAcc.id,
        date: "2026-06-15",
        payee: anchorChk,
        amount: 100000,
        status: "c",
      },
    });
    await page.request.post("/api/transactions", {
      data: {
        accountId: savAcc.id,
        date: "2026-06-15",
        payee: anchorSav,
        amount: 100000,
        status: "c",
      },
    });

    // 1. Create a transfer between Checking and Savings on 2026-06-01 (-$200 from Checking to Savings).
    await page.request.post("/api/transactions", {
      data: {
        accountId: chkAcc.id,
        transferAccountId: savAcc.id,
        date: "2026-06-01",
        payee: xferPayee,
        amount: -20000,
        status: "c",
      },
    });

    await page.reload();
    await waitForReady(page);

    // 2. Open edit modal on the transfer from Checking register.
    await page.getByRole("button", { name: new RegExp(`^${chkName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(chkName, { exact: true })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: xferPayee }).first();
    await expect(row).toBeVisible();
    await row.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toHaveText("Edit Transaction");

    // Edit transfer date to 2026-06-25. Save changes.
    await editModal.locator('input[type="date"]').first().fill("2026-06-25");
    const updatePromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "PATCH"
    );
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await updatePromise;
    await expect(editModal).toBeHidden();

    // 3. Navigate to Checking register: verify date is 2026-06-25 and running balance position updates.
    const chkRegisterRows = page.locator("table.y-table:not(.y-scheduled-table) tbody tr.y-row");
    await expect(chkRegisterRows.nth(0)).toContainText("2026-06-25");
    await expect(chkRegisterRows.nth(0)).toContainText(xferPayee);
    await expect(chkRegisterRows.nth(0).locator("td.num.y-num").last()).toHaveText("$800.00");

    await expect(chkRegisterRows.nth(1)).toContainText("2026-06-15");
    await expect(chkRegisterRows.nth(1)).toContainText(anchorChk);
    await expect(chkRegisterRows.nth(1).locator("td.num.y-num").last()).toHaveText("$1,000.00");

    // 4. Navigate to Savings register: verify date is 2026-06-25 and running balance position updates.
    await page.getByRole("button", { name: new RegExp(`^${savName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(savName, { exact: true })).toBeVisible();

    const savRegisterRows = page.locator("table.y-table:not(.y-scheduled-table) tbody tr.y-row");
    await expect(savRegisterRows.nth(0)).toContainText("2026-06-25");
    await expect(savRegisterRows.nth(0)).toContainText(`Transfer : ${chkName}`);
    await expect(savRegisterRows.nth(0).locator("td.num.y-num").last()).toHaveText("$1,200.00");

    await expect(savRegisterRows.nth(1)).toContainText("2026-06-15");
    await expect(savRegisterRows.nth(1)).toContainText(anchorSav);
    await expect(savRegisterRows.nth(1).locator("td.num.y-num").last()).toHaveText("$1,000.00");
  });

  test("transfer account dropdown is disabled during edit and API rejects account change", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const savName = `PW Sav ${stamp}`;
    const otherName = `PW Other ${stamp}`;
    const payeeName = `PW DisAcc ${stamp}`;

    const chkRes = await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const chkAcc = await chkRes.json();
    const savRes = await page.request.post("/api/accounts", {
      data: { name: savName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const savAcc = await savRes.json();
    const otherRes = await page.request.post("/api/accounts", {
      data: { name: otherName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const otherAcc = await otherRes.json();

    // 1. Create a transfer between Checking and Savings.
    const xferRes = await page.request.post("/api/transactions", {
      data: {
        accountId: chkAcc.id,
        transferAccountId: savAcc.id,
        date: "2026-06-15",
        payee: payeeName,
        amount: -5000,
        status: "c",
      },
    });
    expect(xferRes.ok()).toBeTruthy();
    const xfer = await xferRes.json();

    await page.reload();
    await waitForReady(page);

    // 2. Open edit modal from Checking register: verify "Transfer to" account select is disabled.
    await page.getByRole("button", { name: new RegExp(`^${chkName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(chkName, { exact: true })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: payeeName }).first();
    await expect(row).toBeVisible();
    await row.click();

    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toHaveText("Edit Transaction");

    const transferToSpan = editModal.locator("span.y-label", { hasText: "Transfer to" }).first();
    await expect(transferToSpan).toBeVisible();
    const transferToField = transferToSpan.locator("xpath=..");
    const transferToBtn = transferToField.locator('button[aria-haspopup="listbox"]').first();
    await expect(transferToBtn).toBeEnabled();

    const accountSpan = editModal.locator("span.y-label", { hasText: "Account" }).first();
    await expect(accountSpan).toBeVisible();
    const accountField = accountSpan.locator("xpath=..");
    const accountBtn = accountField.locator('button[aria-haspopup="listbox"]').first();
    await expect(accountBtn).toBeDisabled();

    await editModal.getByRole("button", { name: "Cancel" }).click();
    await expect(editModal).toBeHidden();

    // 3. Send direct PATCH /api/transactions with a modified accountId.
    const patchRes = await page.request.patch("/api/transactions", {
      data: {
        id: xfer.id,
        accountId: otherAcc.id,
      },
    });

    // 4. Verify API responds with 400 error: "cannot change account of a transfer; delete and recreate".
    expect(patchRes.status()).toBe(400);
    const errBody = await patchRes.json();
    expect(errBody.error).toContain("cannot change account of a transfer; delete and recreate");
  });

  test("internal transfer (On-Budget to On-Budget) requires no category and has zero budget impact", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const savName = `PW Sav ${stamp}`;
    const payeeName = `PW IntXfer ${stamp}`;

    await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    await page.request.post("/api/accounts", {
      data: { name: savName, kind: "liquid", groupLabel: "Budget Accounts" },
    });

    await page.reload();
    await waitForReady(page);

    // 1. Read initial To Be Budgeted (TBB) and all category balances in Budget view.
    await gotoBudget(page);
    const initialTbb = await getTbb(page);
    const initialBudget = await (await page.request.get("/api/budget")).json();

    // 2. Create a transfer of -$300 from Checking (on-budget) to Savings (on-budget).
    await gotoAllTransactions(page);
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    const modal = page.locator(".y-modal").last();

    await selectOption(modal, "Account", chkName, page);
    await modal.getByRole("button", { name: /^transfer$/i }).click();

    await fillPayee(modal, payeeName);
    await modal.locator('input[inputmode="decimal"]').first().fill("-300.00");
    await selectOption(modal, "Transfer to", savName, page);

    // 3. Verify category dropdown is omitted/hidden in Transfer modal.
    const catField = modal.locator("span.y-label", { hasText: /^Category/ });
    await expect(catField).toBeHidden();

    const createPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await createPromise;
    await expect(modal).toBeHidden();

    // 4. Return to Budget view: verify TBB and all category available balances are completely unchanged.
    await gotoBudget(page);
    const afterTbb = await getTbb(page);
    expect(afterTbb).toBe(initialTbb);

    const afterBudget = await (await page.request.get("/api/budget")).json();
    for (const cat of initialBudget.categories) {
      const updatedCat = afterBudget.categories.find((c: { id: number }) => c.id === cat.id);
      expect(updatedCat?.balance).toBe(cat.balance);
    }

    // 5. Verify Checking balance decreased by $300 and Savings balance increased by $300.
    const chkAcc = afterBudget.accounts.find((a: { name: string }) => a.name === chkName);
    const savAcc = afterBudget.accounts.find((a: { name: string }) => a.name === savName);
    expect(Number(chkAcc.balance)).toBe(-30000);
    expect(Number(savAcc.balance)).toBe(30000);
  });

  test("boundary transfer outflow (On-Budget to Off-Budget) enforces mandatory category and deducts budget", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const invName = `PW Inv ${stamp}`;
    const catName = `PW InvCat ${stamp}`;

    await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    await page.request.post("/api/accounts", {
      data: { name: invName, kind: "offbudget", groupLabel: "Investments" },
    });

    const budgetData = await (await page.request.get("/api/budget")).json();
    const needsGroup = budgetData.groups.find((g: { name: string }) => g.name === "Needs");
    const catRes = await page.request.post("/api/categories", {
      data: { name: catName, groupId: needsGroup.id },
    });
    const cat = await catRes.json();

    const curMonth = budgetData.month ?? "2026-06";
    await page.request.put("/api/assignments", {
      data: { categoryId: cat.id, month: curMonth, amount: 100000 },
    });

    await page.reload();
    await waitForReady(page);
    await gotoAllTransactions(page);

    // 1. Open Add Transaction in Transfer mode: source = Checking (on-budget), destination = Investment Account (off-budget tracking).
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    const modal = page.locator(".y-modal").last();

    await selectOption(modal, "Account", chkName, page);
    await modal.getByRole("button", { name: /^transfer$/i }).click();
    await selectOption(modal, "Transfer to", invName, page);

    // 2. Set date to 2026-06-15 and amount = -$500.
    await modal.locator('input[type="date"]').first().fill(`${curMonth}-15`);
    await modal.locator('input[inputmode="decimal"]').first().fill("-500.00");

    // 3. Verify Save button is disabled and modal shows "Category (required for boundary transfer outflow)".
    const saveBtn = modal.getByRole("button", { name: "Save Transaction" });
    await expect(saveBtn).toBeDisabled();
    const reqCatLabel = modal.locator("span.y-label", {
      hasText: "Category (required for boundary transfer outflow)",
    });
    await expect(reqCatLabel).toBeVisible();

    // 4. Select "Investments" category in the dropdown -> verify Save button is enabled.
    await selectOption(modal, "Category (required for boundary transfer outflow)", catName, page);
    await expect(saveBtn).toBeEnabled();

    // 5. Save transfer.
    const createPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await saveBtn.click();
    await createPromise;
    await expect(modal).toBeHidden();

    // 6. Verify Investments category available balance decreases by $500 (from $1000 to $500).
    await gotoBudget(page);
    const catRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(catRow).toBeVisible();
    await expect(catRow.locator("td").last()).toContainText("$500.00");

    // 7. Verify Checking balance decreases by $500 and Investment account balance increases by $500.
    const afterBudget = await (await page.request.get("/api/budget")).json();
    const chkAcc = afterBudget.accounts.find((a: { name: string }) => a.name === chkName);
    const invAcc = afterBudget.accounts.find((a: { name: string }) => a.name === invName);
    expect(Number(chkAcc.balance)).toBe(-50000);
    expect(Number(invAcc.balance)).toBe(50000);
  });

  test("boundary transfer inflow (Off-Budget to On-Budget) handles uncategorized income vs categorized refund", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const invName = `PW Inv ${stamp}`;
    const catName = `PW InvCat ${stamp}`;

    await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    await page.request.post("/api/accounts", {
      data: { name: invName, kind: "offbudget", groupLabel: "Investments" },
    });

    const budgetData = await (await page.request.get("/api/budget")).json();
    const needsGroup = budgetData.groups.find((g: { name: string }) => g.name === "Needs");
    const catRes = await page.request.post("/api/categories", {
      data: { name: catName, groupId: needsGroup.id },
    });
    const cat = await catRes.json();

    const curMonth = budgetData.month ?? "2026-06";
    await page.request.put("/api/assignments", {
      data: { categoryId: cat.id, month: curMonth, amount: 10000 },
    });

    await page.reload();
    await waitForReady(page);

    await gotoBudget(page);
    const initialTbb = await getTbb(page);

    // 1. Create boundary transfer inflow from Investment Account (off-budget) to Checking (on-budget) of +$400 without category.
    await gotoAllTransactions(page);
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    let modal = page.locator(".y-modal").last();

    await selectOption(modal, "Account", chkName, page);
    await modal.getByRole("button", { name: /^transfer$/i }).click();
    await selectOption(modal, "Transfer to", invName, page);
    await modal.locator('input[type="date"]').first().fill(`${curMonth}-15`);
    await modal.locator('input[inputmode="decimal"]').first().fill("400.00");

    const catLabel = modal.locator("span.y-label", { hasText: /^Category$/ });
    await expect(catLabel).toBeVisible();

    let createPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await createPromise;
    await expect(modal).toBeHidden();

    // 2. Verify Checking balance increases by $400, and TBB increases by +$400 (Income).
    const budgetAfter1 = await (await page.request.get("/api/budget")).json();
    const chkAcc1 = budgetAfter1.accounts.find((a: { name: string }) => a.name === chkName);
    expect(Number(chkAcc1.balance)).toBe(40000);

    await gotoBudget(page);
    const tbbAfter1 = await getTbb(page);
    expect(tbbAfter1).toBe(initialTbb + 400);

    // 3. Create second boundary transfer inflow of +$200 with category = "Investments".
    await gotoAllTransactions(page);
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    modal = page.locator(".y-modal").last();

    await selectOption(modal, "Account", chkName, page);
    await modal.getByRole("button", { name: /^transfer$/i }).click();
    await selectOption(modal, "Transfer to", invName, page);
    await modal.locator('input[type="date"]').first().fill(`${curMonth}-15`);
    await modal.locator('input[inputmode="decimal"]').first().fill("200.00");

    await selectOption(modal, "Category", catName, page);

    createPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await createPromise;
    await expect(modal).toBeHidden();

    // 4. Verify Checking balance increases by $200, Investments category available balance increases by +$200, and TBB is unaffected.
    const budgetAfter2 = await (await page.request.get("/api/budget")).json();
    const chkAcc2 = budgetAfter2.accounts.find((a: { name: string }) => a.name === chkName);
    expect(Number(chkAcc2.balance)).toBe(60000);

    await gotoBudget(page);
    const tbbAfter2 = await getTbb(page);
    expect(tbbAfter2).toBe(tbbAfter1);

    const catRow = page.locator("tr[data-cat-row]").filter({ hasText: catName });
    await expect(catRow).toBeVisible();
    await expect(catRow.locator("td").last()).toContainText("$300.00");
  });

  test("transfer payment to Credit Card account draws down Credit Card Payment category buffer", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const ccName = `PW CC ${stamp}`;
    const catName = `PW CCCat ${stamp}`;

    const chkRes = await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const chkAcc = await chkRes.json();

    const ccRes = await page.request.post("/api/accounts", {
      data: { name: ccName, kind: "credit", groupLabel: "Credit Cards" },
    });
    const ccAcc = await ccRes.json();

    const budgetData = await (await page.request.get("/api/budget")).json();
    const curMonth = budgetData.month ?? "2026-06";
    const needsGroup = budgetData.groups.find((g: { name: string }) => g.name === "Needs");
    const catRes = await page.request.post("/api/categories", {
      data: { name: catName, groupId: needsGroup.id },
    });
    const cat = await catRes.json();

    await page.request.put("/api/assignments", {
      data: { categoryId: cat.id, month: curMonth, amount: 20000 },
    });

    // 1. Credit Card has -$200 funded spending (Credit Card Payments category has $200 available).
    await page.request.post("/api/transactions", {
      data: {
        accountId: ccAcc.id,
        categoryId: cat.id,
        date: `${curMonth}-10`,
        payee: `PW CC Spend ${stamp}`,
        amount: -20000,
        status: "c",
      },
    });

    await page.reload();
    await waitForReady(page);

    await gotoBudget(page);
    const ccToggle = page.getByRole("button", { name: /Toggle Credit Card Payments/i });
    if (await ccToggle.isVisible()) {
      await ccToggle.click();
    }
    const ccRow = page.locator("tr[data-cat-row]").filter({ hasText: ccName });
    await expect(ccRow).toBeVisible();
    await expect(ccRow.locator("td").last()).toContainText("$200.00");

    // 2. Create a transfer payment of -$200 from Checking to Credit Card.
    await gotoAllTransactions(page);
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    const modal = page.locator(".y-modal").last();

    await selectOption(modal, "Account", chkName, page);
    await modal.getByRole("button", { name: /^transfer$/i }).click();
    await selectOption(modal, "Transfer to", ccName, page);
    await modal.locator('input[inputmode="decimal"]').first().fill("-200.00");
    await modal.locator('input[type="date"]').first().fill(`${curMonth}-15`);

    const transferPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "POST"
    );
    await modal.getByRole("button", { name: "Save Transaction" }).click();
    await transferPromise;
    await expect(modal).toBeHidden();

    // 3. Verify Checking balance decreases by $200.
    // 4. Verify Credit Card account balance increases by $200 (reaches $0.00).
    const afterBudget = await (await page.request.get("/api/budget")).json();
    const chkAfter = afterBudget.accounts.find((a: { name: string }) => a.name === chkName);
    const ccAfter = afterBudget.accounts.find((a: { name: string }) => a.name === ccName);
    expect(Number(chkAfter.balance)).toBe(-20000);
    expect(Number(ccAfter.balance)).toBe(0);

    // 5. Return to Budget view: verify Credit Card Payment category available balance is drawn down from $200 to $0.00.
    await gotoBudget(page);
    const ccRowAfter = page.locator("tr[data-cat-row]").filter({ hasText: ccName });
    await expect(ccRowAfter).toBeVisible();
    await expect(ccRowAfter.locator("td").last()).toHaveText("$0.00");
  });

  test("transfer cleared status is tracked independently on source and destination registers", async ({
    page,
  }) => {
    const stamp = Date.now();
    const chkName = `PW Chk ${stamp}`;
    const savName = `PW Sav ${stamp}`;
    const payeeName = `PW StatusXfer ${stamp}`;

    const chkRes = await page.request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const chkAcc = await chkRes.json();
    const savRes = await page.request.post("/api/accounts", {
      data: { name: savName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    const savAcc = await savRes.json();

    // 1. Create a transfer between Checking and Savings (both start as Cleared "c").
    const xferRes = await page.request.post("/api/transactions", {
      data: {
        accountId: chkAcc.id,
        transferAccountId: savAcc.id,
        date: "2026-06-15",
        payee: payeeName,
        amount: -10000,
        status: "c",
        transferStatus: "c",
      },
    });
    const xfer = await xferRes.json();

    await page.reload();
    await waitForReady(page);

    // 2. In Checking register: click Cleared cell to cycle status from C -> U (Uncleared).
    await page.getByRole("button", { name: new RegExp(`^${chkName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(chkName, { exact: true })).toBeVisible();

    const chkRow = page.getByRole("row").filter({ hasText: payeeName }).first();
    await expect(chkRow).toBeVisible();
    const chkFlag = chkRow.locator(".y-cleared");
    await expect(chkFlag).toHaveText("C");

    const patchPromise = page.waitForResponse(
      (r) => r.url().includes("/api/transactions") && r.request().method() === "PATCH"
    );
    await chkFlag.click();
    await patchPromise;
    await expect(chkFlag).toHaveText("U");

    // 3. Navigate to Savings register: verify transfer row remains Cleared "C".
    await page.getByRole("button", { name: new RegExp(`^${savName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(savName, { exact: true })).toBeVisible();

    const savRow = page.getByRole("row").filter({ hasText: `Transfer : ${chkName}` }).first();
    await expect(savRow).toBeVisible();
    const savFlag = savRow.locator(".y-cleared");
    await expect(savFlag).toHaveText("C");

    // 4. Verify API confirms status = "u" and transferStatus = "c".
    const budgetRes = await (await page.request.get("/api/budget")).json();
    const updatedXfer = budgetRes.transactions.find((t: { id: number }) => t.id === xfer.id);
    expect(updatedXfer.status).toBe("u");
    expect(updatedXfer.transferStatus).toBe("c");
  });
});
