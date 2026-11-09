import type { Transaction } from "@ynab/logic";

export type Txn = Omit<Transaction, "amount"> & { amount: number; runningBalance: number | null };

export type SortKey =
  | "date"
  | "account"
  | "payee"
  | "category"
  | "memo"
  | "outflow"
  | "inflow"
  | "cleared"
  | "flag"
  | "balance";

export type SortState = { key: SortKey; dir: "asc" | "desc" };
