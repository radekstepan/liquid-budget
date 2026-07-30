import type { BudgetData, CatRow, GroupRow } from "./types";
import { num } from "./format";

// outflow for a category in a given month = sum of that month's transactions
// (negative amounts contribute negative outflow; inflows reduce it)
export function computeGroups(data: BudgetData, month: string): GroupRow[] {
  const assignMap = new Map<number, number>();
  for (const a of data.assignments) {
    if (a.month === month) assignMap.set(a.categoryId, num(a.amount));
  }

  const outflowMap = new Map<number, number>();
  for (const t of data.transactions) {
    if (t.categoryId == null) continue;
    if (!t.date.startsWith(month)) continue;
    outflowMap.set(t.categoryId, (outflowMap.get(t.categoryId) ?? 0) + num(t.amount));
  }

  const catsByGroup = new Map<number, CatRow[]>();
  for (const c of data.categories) {
    const assigned = assignMap.get(c.id) ?? 0;
    const outflow = Math.min(0, outflowMap.get(c.id) ?? 0); // clamp inflow to 0 for display
    const rawFlow = outflowMap.get(c.id) ?? 0;
    const available = num(c.carryover) + assigned + rawFlow;
    const fundedPct = assigned > 0 ? Math.max(0, Math.min(1, available / assigned)) : available > 0 ? 1 : 0;
    const row: CatRow = { category: c, assigned, outflow, available, fundedPct };
    const arr = catsByGroup.get(c.groupId) ?? [];
    arr.push(row);
    catsByGroup.set(c.groupId, arr);
  }

  return data.groups.map((group) => {
    const rows = (catsByGroup.get(group.id) ?? []).sort(
      (a, b) => a.category.sort - b.category.sort
    );
    const assigned = rows.reduce((s, r) => s + r.assigned, 0);
    const outflow = rows.reduce((s, r) => s + r.outflow, 0);
    const available = rows.reduce((s, r) => s + r.available, 0);
    return { group, rows, assigned, outflow, available };
  });
}

export function summarize(groups: GroupRow[]) {
  const budgetGroups = groups.filter((g) => !g.group.isCreditCardPayments);
  const assigned = budgetGroups.reduce((s, g) => s + g.assigned, 0);
  const outflow = budgetGroups.reduce((s, g) => s + g.outflow, 0);
  const available = budgetGroups.reduce((s, g) => s + g.available, 0);
  const totalAvailable = groups.reduce((s, g) => s + g.available, 0);
  return { assigned, outflow, available, totalAvailable };
}
