// apps/web/tests/e2e/reconcile-locks-edge-cases.spec.ts
//
// Comprehensive End-to-End Test Suite for Reconciled Transaction Locks:
//   1. Reconciled transaction locks cleared toggle and prevents inline modification
//   2. Attempting to edit or delete a reconciled transaction via API returns 422 locked error
//   3. Unreconciling a transaction via edit modal confirms warning and unlocks structural edits
//   4. Reconciling an account with split transactions locks all sub-transactions
//   5. Reconciling one side of a transfer locks only the reconciled account side
//
// Skeletons define the exact behavior and verification steps required for 100% reconcile lock coverage.

import { test, expect, type Page } from "@playwright/test";
import { fillSearchlist } from "./helpers";

async function waitForReady(page: Page) {
  await expect(page.getByText("Loading budget")).toBeHidden({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForReady(page);
});

test.describe("Reconcile Locks & Immutability Edge Cases", () => {
  test("reconciled transaction locks cleared toggle and prevents inline modification", async ({ page }) => {
    // 1. Navigate to an account register with a reconciled ('R') transaction.
    const stamp = Date.now();
    const accName = `PW RecLock ${stamp}`;
    const payee = `PW Lock Txn ${stamp}`;

    // Create a fresh isolated account
    await page.getByRole("button", { name: "Add Account" }).click();
    const accModal = page.locator(".y-modal").last();
    await accModal.locator('input[placeholder="e.g. TD Chequing"]').fill(accName);
    await accModal.getByRole("button", { name: "Add Account" }).click();
    await expect(accModal).toBeHidden();

    // Navigate to the newly created account register
    await page.getByRole("button", { name: new RegExp(`^${accName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(accName, { exact: true })).toBeVisible();

    // Add a fresh cleared transaction
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.locator('input[inputmode="decimal"]').first().fill("15.50");
    await addModal.locator('input[type="date"]').first().fill("2026-08-15");
    await fillSearchlist(addModal, "e.g. Whole Foods", payee);
    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // Verify row is cleared 'C'
    const row = page.getByRole("row").filter({ hasText: payee }).first();
    const flag = row.locator(".y-cleared");
    await expect(flag).toHaveText("C");

    // Reconcile account
    await page.getByRole("button", { name: /Reconcile/i }).click();
    const rModal = page.locator(".y-modal").last();
    await expect(rModal.locator(".y-modal-head")).toHaveText(new RegExp(`Reconcile: ${accName}`));
    await rModal.getByRole("button", { name: "Reconcile", exact: true }).click();
    await expect(rModal).toBeHidden();

    // 2. Locate the row with the "R" status glyph
    await expect(flag).toHaveText("R");

    // 3. Verify the "R" glyph does not have role="button" and cursor is default (not interactive cursor-pointer)
    await expect(flag).not.toHaveRole("button");
    await expect(flag).not.toHaveClass(/cursor-pointer/);

    // 4. Click the "R" glyph: verify status does not change to "U" or "C"
    await flag.click({ force: true });
    await expect(flag).toHaveText("R");

    // 5. Select the row and press keyboard shortcut 'c' or Space: verify status remains locked at "R"
    const tableContainer = page.locator('.y-scroll[tabindex="0"]');
    await tableContainer.focus();
    await page.keyboard.press("ArrowDown");
    const selectedRow = page.locator("tr.y-row--selected");
    await expect(selectedRow).toBeVisible();

    await page.keyboard.press("c");
    await expect(flag).toHaveText("R");

    await page.keyboard.press(" ");
    await expect(flag).toHaveText("R");
  });

  test("attempting to edit or delete a reconciled transaction via API returns 422 locked error", async ({ request }) => {
    // 1. Identify a transaction with status = 'r'.
    const stamp = Date.now();
    const accName = `PW RecApiAcc ${stamp}`;

    const accRes = await request.post("/api/accounts", {
      data: { name: accName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    expect(accRes.ok()).toBeTruthy();
    const acc = await accRes.json();

    const txnRes = await request.post("/api/transactions", {
      data: {
        accountId: acc.id,
        date: "2026-08-01",
        payee: `PW RecApi Payee ${stamp}`,
        amount: -5000,
        status: "c",
      },
    });
    expect(txnRes.ok()).toBeTruthy();
    const txn = await txnRes.json();

    const recRes = await request.post("/api/reconcile", {
      data: {
        accountId: acc.id,
        statementBalance: -5000,
      },
    });
    expect(recRes.ok()).toBeTruthy();

    const budgetRes = await request.get("/api/budget");
    const budget = await budgetRes.json();
    const reconciledTxn = budget.transactions.find((t: { id: number }) => t.id === txn.id);
    expect(reconciledTxn?.status).toBe("r");

    // 2. Send PATCH /api/transactions trying to alter amount or payee.
    const patchAmountRes = await request.patch("/api/transactions", {
      data: {
        id: txn.id,
        amount: -7500,
      },
    });
    // 3. Verify API responds with status 422: "Transaction is reconciled and locked. Unreconcile before editing."
    expect(patchAmountRes.status()).toBe(422);
    const patchAmountBody = await patchAmountRes.json();
    expect(patchAmountBody.error).toBe("Transaction is reconciled and locked. Unreconcile before editing.");

    const patchPayeeRes = await request.patch("/api/transactions", {
      data: {
        id: txn.id,
        payee: "Attempted Payee Change",
      },
    });
    expect(patchPayeeRes.status()).toBe(422);
    const patchPayeeBody = await patchPayeeRes.json();
    expect(patchPayeeBody.error).toBe("Transaction is reconciled and locked. Unreconcile before editing.");

    // 4. Send DELETE /api/transactions for the same id.
    const delRes = await request.delete(`/api/transactions?id=${txn.id}`);
    // 5. Verify API responds with status 422: "Transaction is reconciled and locked. Unreconcile before deleting."
    expect(delRes.status()).toBe(422);
    const delBody = await delRes.json();
    expect(delBody.error).toBe("Transaction is reconciled and locked. Unreconcile before deleting.");
  });

  test("unreconciling a transaction via edit modal confirms warning and unlocks structural edits", async ({ page }) => {
    // 1. Open edit modal on a reconciled transaction.
    const stamp = Date.now();
    const accName = `PW RecUnrec ${stamp}`;
    const payee = `PW Unrec Payee ${stamp}`;

    // Create account via UI
    await page.getByRole("button", { name: "Add Account" }).click();
    const accModal = page.locator(".y-modal").last();
    await accModal.locator('input[placeholder="e.g. TD Chequing"]').fill(accName);
    await accModal.getByRole("button", { name: "Add Account" }).click();
    await expect(accModal).toBeHidden();

    // Navigate to account register
    await page.getByRole("button", { name: new RegExp(`^${accName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(accName, { exact: true })).toBeVisible();

    // Add transaction
    await page.getByRole("button", { name: "Add a new transaction", exact: true }).click();
    const addModal = page.locator(".y-modal").last();
    await addModal.locator('input[inputmode="decimal"]').first().fill("20.00");
    await addModal.locator('input[type="date"]').first().fill("2026-08-15");
    await fillSearchlist(addModal, "e.g. Whole Foods", payee);
    await addModal.getByRole("button", { name: "Save Transaction" }).click();
    await expect(addModal).toBeHidden();

    // Reconcile account
    await page.getByRole("button", { name: /Reconcile/i }).click();
    const rModal = page.locator(".y-modal").last();
    await rModal.getByRole("button", { name: "Reconcile", exact: true }).click();
    await expect(rModal).toBeHidden();

    const row = page.getByRole("row").filter({ hasText: payee }).first();
    await expect(row.locator(".y-cleared")).toHaveText("R");

    // 1. Open edit modal on a reconciled transaction.
    await row.click();
    const editModal = page.locator(".y-modal").last();
    await expect(editModal.locator(".y-modal-head")).toHaveText("Edit Transaction");

    // 2. Toggle the "Cleared" flag off.
    await editModal.getByRole("button", { name: "Cleared", exact: true }).click();

    // 3. Verify confirmation modal appears: "Unreconcile Transaction? Unreconciling a transaction will affect past reconciliation rounds."
    await expect(editModal.locator(".y-modal-head")).toHaveText("Unreconcile Transaction?");
    await expect(editModal.getByText("Unreconciling a transaction will affect past reconciliation rounds.")).toBeVisible();
    await expect(editModal.getByText("Past reconciliation affected")).toBeVisible();

    // 4. Click "Yes, unreconcile".
    await editModal.getByRole("button", { name: "Yes, unreconcile" }).click();

    // 5. Verify fields (Amount, Date, Payee, Category) are now editable.
    await expect(editModal.locator(".y-modal-head")).toHaveText("Edit Transaction");
    const amountInput = editModal.locator('input[inputmode="decimal"]').first();
    const dateInput = editModal.locator('input[type="date"]').first();
    await expect(amountInput).toBeEnabled();
    await expect(dateInput).toBeEnabled();
    await expect(editModal.getByRole("button", { name: "Uncleared", exact: true })).toHaveText("U");

    // 6. Update amount and save changes.
    await amountInput.fill("45.00");
    await editModal.getByRole("button", { name: "Save Changes" }).click();
    await expect(editModal).toBeHidden();

    // 7. Verify transaction saves with status "u" and new amount is persisted.
    await expect(row.locator(".y-cleared")).toHaveText("U");
    await expect(row).toContainText("$45.00");

    const budgetRes = await page.request.get("/api/budget");
    const budget = await budgetRes.json();
    const updatedTxn = budget.transactions.find((t: { payee: string }) => t.payee === payee);
    expect(updatedTxn?.status).toBe("u");
    expect(Number(updatedTxn?.amount)).toBe(4500);
  });

  test("reconciling an account with split transactions locks all sub-transactions", async ({ request }) => {
    // 1. Create a split transaction in an account.
    const stamp = Date.now();
    const initBudget = await (await request.get("/api/budget")).json();
    const categoryId = initBudget.categories[0]?.id;
    expect(categoryId).toBeTruthy();

    const accRes = await request.post("/api/accounts", {
      data: { name: `PW SplitLock ${stamp}`, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    expect(accRes.ok()).toBeTruthy();
    const acc = await accRes.json();

    const splitRes = await request.post("/api/transactions", {
      data: {
        accountId: acc.id,
        date: "2026-08-01",
        payee: `PW SplitLock Payee ${stamp}`,
        amount: -6000,
        status: "c",
        subTransactions: [
          { categoryId, amount: -4000, memo: "Split part 1" },
          { categoryId, amount: -2000, memo: "Split part 2" },
        ],
      },
    });
    expect(splitRes.ok()).toBeTruthy();
    const { parent: splitParent } = await splitRes.json();

    // 2. Reconcile the account.
    const recRes = await request.post("/api/reconcile", {
      data: {
        accountId: acc.id,
        statementBalance: -6000,
      },
    });
    expect(recRes.ok()).toBeTruthy();

    // 3. Verify in DB/API that split parent and all child subtransactions have status = 'r'.
    const budgetRes = await request.get("/api/budget");
    const budget = await budgetRes.json();
    const parentTxn = budget.transactions.find((t: { id: number }) => t.id === splitParent.id);
    expect(parentTxn?.status).toBe("r");

    const children = budget.transactions.filter((t: { parentId: number | null }) => t.parentId === splitParent.id);
    expect(children.length).toBe(2);
    for (const child of children) {
      expect(child.status).toBe("r");
    }

    // 4. Attempt to update a child subtransaction amount or category via API: verify 422 error is returned.
    const childToUpdate = children[0];
    const updateChildRes = await request.patch("/api/transactions", {
      data: {
        id: childToUpdate.id,
        amount: -4500,
      },
    });
    expect(updateChildRes.status()).toBe(422);
    const updateChildBody = await updateChildRes.json();
    expect(updateChildBody.error).toBe("Transaction is reconciled and locked. Unreconcile before editing.");

    // 5. Attempt to delete the split parent: verify 422 error is returned.
    const delParentRes = await request.delete(`/api/transactions?id=${splitParent.id}`);
    expect(delParentRes.status()).toBe(422);
    const delParentBody = await delParentRes.json();
    expect(delParentBody.error).toBe("Transaction is reconciled and locked. Unreconcile before deleting.");
  });

  test("reconciling one side of a transfer locks only the reconciled account side", async ({ page, request }) => {
    // 1. Create a transfer between Checking and Savings.
    const stamp = Date.now();
    const chkName = `PW RecChk ${stamp}`;
    const savName = `PW RecSav ${stamp}`;

    const chkRes = await request.post("/api/accounts", {
      data: { name: chkName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    expect(chkRes.ok()).toBeTruthy();
    const chkAcc = await chkRes.json();

    const savRes = await request.post("/api/accounts", {
      data: { name: savName, kind: "liquid", groupLabel: "Budget Accounts" },
    });
    expect(savRes.ok()).toBeTruthy();
    const savAcc = await savRes.json();

    const xferRes = await request.post("/api/transactions", {
      data: {
        accountId: chkAcc.id,
        transferAccountId: savAcc.id,
        date: "2026-08-01",
        amount: -10000,
        status: "c",
        transferStatus: "c",
      },
    });
    expect(xferRes.ok()).toBeTruthy();
    const xferTxn = await xferRes.json();

    // 2. Reconcile Checking account.
    const recRes = await request.post("/api/reconcile", {
      data: {
        accountId: chkAcc.id,
        statementBalance: -10000,
      },
    });
    expect(recRes.ok()).toBeTruthy();

    await page.goto("/");
    await waitForReady(page);

    // 3. Verify Checking register displays "R" for the transfer leg.
    await page.getByRole("button", { name: new RegExp(`^${chkName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(chkName, { exact: true })).toBeVisible();

    const chkRow = page.getByRole("row").filter({ hasText: `Transfer : ${savName}` }).first();
    await expect(chkRow).toBeVisible();
    const chkFlag = chkRow.locator(".y-cleared");
    await expect(chkFlag).toHaveText("R");
    await expect(chkFlag).not.toHaveRole("button");

    // 4. Navigate to Savings register: verify transfer leg displays "C" (unreconciled).
    await page.getByRole("button", { name: new RegExp(`^${savName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(savName, { exact: true })).toBeVisible();

    const savRow = page.getByRole("row").filter({ hasText: `Transfer : ${chkName}` }).first();
    await expect(savRow).toBeVisible();
    const savFlag = savRow.locator(".y-cleared");
    await expect(savFlag).toHaveText("C");
    await expect(savFlag).toHaveRole("button");

    // 5. Verify Cycling cleared status on Savings leg toggles C -> U without affecting Checking's 'R' lock.
    await savFlag.click();
    await expect(savFlag).toHaveText("U");

    // Navigate back to Checking register to verify 'R' is untouched
    await page.getByRole("button", { name: new RegExp(`^${chkName} `) }).first().click();
    await expect(page.locator(".y-toolbar").getByText(chkName, { exact: true })).toBeVisible();
    await expect(chkFlag).toHaveText("R");
    await expect(chkFlag).not.toHaveRole("button");

    // Verify in API that status is 'r' and transferStatus is 'u'
    const budgetRes = await request.get("/api/budget");
    const budget = await budgetRes.json();
    const updatedXfer = budget.transactions.find((t: { id: number }) => t.id === xferTxn.id);
    expect(updatedXfer?.status).toBe("r");
    expect(updatedXfer?.transferStatus).toBe("u");
  });
});
