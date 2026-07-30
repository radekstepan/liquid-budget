export type Account = {
  id: number;
  name: string;
  kind: "liquid" | "credit" | "offbudget";
  groupLabel: string;
  balance: string;
  onBudget: boolean;
  sort: number;
};

export type CategoryGroup = {
  id: number;
  name: string;
  sort: number;
  isCreditCardPayments: boolean;
};

export type Category = {
  id: number;
  groupId: number;
  name: string;
  sort: number;
  carryover: string;
  goalTarget: string | null;
  linkedAccountId: number | null;
};

export type Assignment = {
  id: number;
  categoryId: number;
  month: string;
  amount: string;
};

export type Transaction = {
  id: number;
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: string;
  cleared: boolean;
  createdAt?: string;
};

export type Recurring = {
  id: number;
  accountId: number;
  categoryId: number | null;
  payee: string;
  amount: string;
  frequency: string;
  nextDate: string;
  active: boolean;
};

export type BudgetData = {
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  recurring: Recurring[];
};

// ---- derived types ----
export type CatRow = {
  category: Category;
  assigned: number;
  outflow: number; // negative or zero
  available: number;
  fundedPct: number; // 0..1
};

export type GroupRow = {
  group: CategoryGroup;
  rows: CatRow[];
  assigned: number;
  outflow: number;
  available: number;
};
