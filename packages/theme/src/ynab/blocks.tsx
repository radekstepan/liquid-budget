import React, { useState } from "react";
import {
  Bar,
  Button,
  Checkbox,
  ClearedFlag,
  Icon,
  Pill,
  Select,
  TextField,
  Toolbar,
  ToolbarSep,
  balanceTone,
  cx,
  money,
} from "./primitives";

/* ==================================================================
   SIDEBAR  —  dark slate rail with account groups + running totals
   ================================================================== */
export type Account = { name: string; balance: number };

export const Sidebar: React.FC<{
  active?: string;
  onSelect?: (s: string) => void;
  compact?: boolean;
}> = ({ active = "Budget", onSelect, compact }) => {
  const budgetAccts: Account[] = [
    { name: "Checking", balance: 2418.63 },
    { name: "Savings", balance: 6100.0 },
    { name: "Cash", balance: 84.25 },
    { name: "Visa Rewards", balance: -412.87 },
  ];
  const tracking: Account[] = [
    { name: "401(k)", balance: 41230.11 },
    { name: "Mortgage", balance: -184300.0 },
  ];
  const sum = (a: Account[]) => a.reduce((t, x) => t + x.balance, 0);

  const Row = (a: Account) => (
    <button
      key={a.name}
      className={cx("y-side-item", active === a.name && "is-sel")}
      onClick={() => onSelect?.(a.name)}
    >
      <span className="truncate">{a.name}</span>
      <span
        className="y-side-amt"
        style={{ color: a.balance < 0 ? "#ea8b7d" : undefined }}
      >
        {money(a.balance)}
      </span>
    </button>
  );

  return (
    <div className={cx("y-sidebar flex flex-col", compact ? "w-[196px]" : "w-[214px]")}>
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div
            className="w-[22px] h-[22px] rounded-[3px] grid place-items-center text-[11px] font-black text-white"
            style={{
              background: "linear-gradient(#96c95c,#5c8f2c)",
              boxShadow: "0 1px 0 rgba(255,255,255,.3) inset",
              border: "1px solid #43701d",
            }}
          >
            Y
          </div>
          <div className="leading-none">
            <div className="text-[13px] font-bold text-white tracking-wide">YNAB</div>
            <div className="text-[9px] text-[#8ea0ab] tracking-[.14em]">MY BUDGET</div>
          </div>
        </div>
      </div>
      <div className="y-divider opacity-[.12]" />

      {["Budget", "Accounts", "Reports"].map((n) => (
        <button
          key={n}
          className={cx("y-side-item y-side-nav", active === n && "is-sel")}
          onClick={() => onSelect?.(n)}
        >
          <Icon
            name={n === "Budget" ? "budget" : n === "Accounts" ? "wallet" : "chart"}
            size={14}
          />
          {n}
        </button>
      ))}

      <div className="y-side-head flex items-center">
        <span>Budget Accounts</span>
        <span className="y-side-amt">{money(sum(budgetAccts))}</span>
      </div>
      {budgetAccts.map(Row)}

      <div className="y-side-head flex items-center">
        <span>Tracking Accounts</span>
        <span className="y-side-amt">{money(sum(tracking))}</span>
      </div>
      {tracking.map(Row)}

      <div className="mt-auto p-2">
        <button className="y-side-item text-[11px] rounded-[3px] border border-white/15 bg-white/5 justify-center">
          + Add Account
        </button>
      </div>
    </div>
  );
};

/* ==================================================================
   MONTH NAVIGATOR
   ================================================================== */
export const MonthNav: React.FC<{ month?: string }> = ({ month = "January 2013" }) => (
  <div className="flex items-center gap-2">
    <Button size="sm" icon={<Icon name="left" size={11} />} aria-label="Previous month" />
    <div className="text-[15px] font-bold text-[#3b4245] min-w-[132px] text-center [text-shadow:0_1px_0_rgba(255,255,255,.8)]">
      {month}
    </div>
    <Button size="sm" icon={<Icon name="right" size={11} />} aria-label="Next month" />
  </div>
);

/* ==================================================================
   BUDGET HEADER  —  the "math strip" + Available to Budget box
   ================================================================== */
const MathCell: React.FC<{ label: string; value: number; danger?: boolean }> = ({
  label,
  value,
  danger,
}) => (
  <div className="y-mathbox">
    <div className="y-math-label">{label}</div>
    <div className="y-math-val" style={{ color: danger ? "#c0483a" : undefined }}>
      {money(value)}
    </div>
  </div>
);

export const BudgetHeader: React.FC<{ atb?: number }> = ({ atb = 312.44 }) => {
  const tone = atb > 0 ? "green" : atb < 0 ? "red" : "orange";
  return (
    <div
      className="flex items-center gap-3 px-3 py-3 flex-wrap"
      style={{
        background: "linear-gradient(#f6f6f4,#e7e7e4)",
        borderBottom: "1px solid #bdbdb8",
      }}
    >
      <MathCell label="Not Budgeted in Dec" value={0} />
      <span className="y-math-op">+</span>
      <MathCell label="Overspent in Dec" value={-38.12} danger />
      <span className="y-math-op">+</span>
      <MathCell label="Income for January" value={4820.0} />
      <span className="y-math-op">−</span>
      <MathCell label="Budgeted in January" value={4469.44} />
      <span className="y-math-op">=</span>
      <div className={cx("y-atb", `y-atb--${tone}`)}>
        <div className="text-[20px] font-bold leading-[1.1] y-num">{money(atb)}</div>
        <div className="text-[9px] font-bold tracking-[.09em] uppercase opacity-90">
          Available to Budget
        </div>
      </div>
    </div>
  );
};

/* ==================================================================
   BUDGET TABLE
   ================================================================== */
export type Cat = { name: string; budgeted: number; outflow: number; balance: number };
export type MasterCat = { name: string; cats: Cat[] };

export const budgetData: MasterCat[] = [
  {
    name: "Monthly Bills",
    cats: [
      { name: "Rent/Mortgage", budgeted: 1450, outflow: 1450, balance: 0 },
      { name: "Electric", budgeted: 95, outflow: 78.42, balance: 16.58 },
      { name: "Water", budgeted: 45, outflow: 45, balance: 0 },
      { name: "Internet", budgeted: 69.99, outflow: 69.99, balance: 0 },
      { name: "Cell Phone", budgeted: 85, outflow: 120.35, balance: -35.35 },
    ],
  },
  {
    name: "Everyday Expenses",
    cats: [
      { name: "Groceries", budgeted: 600, outflow: 412.88, balance: 187.12 },
      { name: "Fuel", budgeted: 180, outflow: 164.2, balance: 15.8 },
      { name: "Spending Money", budgeted: 200, outflow: 243.75, balance: -43.75 },
      { name: "Restaurants", budgeted: 150, outflow: 96.4, balance: 53.6 },
      { name: "Household Goods", budgeted: 75, outflow: 31.09, balance: 43.91 },
    ],
  },
  {
    name: "Rainy Day Funds",
    cats: [
      { name: "Car Maintenance", budgeted: 100, outflow: 0, balance: 640.0 },
      { name: "Christmas", budgeted: 75, outflow: 0, balance: 225.0 },
      { name: "Renter's Insurance", budgeted: 18.5, outflow: 0, balance: 92.5 },
      { name: "Emergency Fund", budgeted: 250, outflow: 0, balance: 3100.0 },
    ],
  },
  {
    name: "Savings Goals",
    cats: [
      { name: "Vacation", budgeted: 125, outflow: 0, balance: 875.0 },
      { name: "New Laptop", budgeted: 60, outflow: 0, balance: 180.0 },
    ],
  },
];

export const BudgetTable: React.FC<{
  data?: MasterCat[];
  selected?: string;
  onSelect?: (name: string) => void;
}> = ({ data = budgetData, selected, onSelect }) => {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  return (
    <table className="y-table">
      <thead className="y-thead">
        <tr>
          <th style={{ width: 26 }} />
          <th>Category</th>
          <th className="num" style={{ width: 118 }}>
            Budgeted
          </th>
          <th className="num" style={{ width: 118 }}>
            Outflows
          </th>
          <th className="num" style={{ width: 128 }}>
            Balance
          </th>
        </tr>
      </thead>
      <tbody>
        {data.map((m) => {
          const isClosed = closed[m.name];
          const sum = (k: keyof Cat) =>
            m.cats.reduce((t, c) => t + (c[k] as number), 0);
          return (
            <React.Fragment key={m.name}>
              <tr className="y-master">
                <td className="text-center">
                  <Checkbox
                    checked={!!checked[m.name]}
                    onChange={(v) => setChecked({ ...checked, [m.name]: v })}
                  />
                </td>
                <td>
                  <button
                    className="flex items-center gap-[7px]"
                    onClick={() => setClosed({ ...closed, [m.name]: !isClosed })}
                  >
                    <span className={cx("y-tri", !isClosed && "is-open")} />
                    {m.name}
                  </button>
                </td>
                <td className="num text-right y-num">{money(sum("budgeted"))}</td>
                <td className="num text-right y-num">{money(sum("outflow"))}</td>
                <td className="num text-right y-num">{money(sum("balance"))}</td>
              </tr>
              {!isClosed &&
                m.cats.map((c, i) => (
                  <tr
                    key={c.name}
                    className={cx("y-row", i % 2 === 1 && "alt", selected === c.name && "is-sel")}
                    onClick={() => onSelect?.(c.name)}
                  >
                    <td className="text-center">
                      <Checkbox
                        checked={!!checked[c.name]}
                        onChange={(v) => setChecked({ ...checked, [c.name]: v })}
                      />
                    </td>
                    <td className="pl-[26px]">{c.name}</td>
                    <td className="num">
                      <input
                        className="y-inline-amt"
                        defaultValue={money(c.budgeted)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="num y-num" style={{ color: "#5d6467" }}>
                      {money(c.outflow)}
                    </td>
                    <td className="num">
                      <Pill tone={balanceTone(c.balance)}>{money(c.balance)}</Pill>
                    </td>
                  </tr>
                ))}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
};

/* ==================================================================
   CATEGORY INSPECTOR  (right rail)
   ================================================================== */
export const Inspector: React.FC<{ category?: string }> = ({ category = "Groceries" }) => (
  <div
    className="w-[236px] shrink-0 p-3 space-y-3 y-scroll overflow-auto"
    style={{
      background: "linear-gradient(#f2f2f0,#e8e8e5)",
      borderLeft: "1px solid #c4c4bf",
      boxShadow: "1px 0 0 rgba(255,255,255,.7) inset",
    }}
  >
    <div>
      <div className="y-caps mb-[6px]">Selected Category</div>
      <div className="text-[14px] font-bold text-[#3b4245]">{category}</div>
    </div>

    <div className="y-panel p-[10px]">
      <div className="flex items-baseline justify-between mb-1">
        <span className="y-label">Available Balance</span>
        <Pill tone="green">{money(187.12)}</Pill>
      </div>
      <div className="y-divider my-2" />
      <dl className="text-[11px] space-y-[5px] text-[#5d6467]">
        {[
          ["Budgeted this month", money(600)],
          ["Spent this month", money(-412.88)],
          ["Avg. spent (3 mo.)", money(-528.4)],
          ["Avg. budgeted (3 mo.)", money(575)],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <dt>{k}</dt>
            <dd className="y-num">{v}</dd>
          </div>
        ))}
      </dl>
    </div>

    <div className="y-panel overflow-hidden">
      <div className="y-panel-head">Goal · Monthly Funding</div>
      <div className="p-[10px]">
        <div className="flex justify-between text-[11px] mb-[6px] text-[#5d6467]">
          <span>Funded {money(600)} of {money(650)}</span>
          <span className="font-bold">92%</span>
        </div>
        <Bar pct={92} />
        <div className="y-hint mt-[6px]">Budget {money(50)} more to reach your target.</div>
      </div>
    </div>

    <div className="y-panel overflow-hidden">
      <div className="y-panel-head">Quick Budget</div>
      <div className="p-[10px] grid grid-cols-2 gap-[6px]">
        {["Average Spent", "Average Budgeted", "Budgeted Last Month", "Spent Last Month"].map(
          (b) => (
            <Button key={b} size="sm">
              {b}
            </Button>
          )
        )}
      </div>
    </div>

    <div className="y-panel overflow-hidden">
      <div className="y-panel-head">Category Notes</div>
      <div className="p-[10px]">
        <textarea
          className="y-input w-full h-[62px] resize-none text-[11.5px]"
          defaultValue="Aldi run on the 1st and 15th. Keep under $150/wk."
        />
      </div>
    </div>
  </div>
);

/* ==================================================================
   REGISTER (account transactions)
   ================================================================== */
export type Txn = {
  flag?: string;
  date: string;
  payee: string;
  category: string;
  memo: string;
  outflow: number;
  inflow: number;
  cleared: "c" | "u" | "r";
  split?: boolean;
};

export const txns: Txn[] = [
  { date: "01/02/2013", payee: "Paycheck — Acme Co.", category: "Income for January", memo: "", outflow: 0, inflow: 2410, cleared: "r", flag: "#7cb342" },
  { date: "01/03/2013", payee: "Blue Ridge Property", category: "Monthly Bills: Rent/Mortgage", memo: "January rent", outflow: 1450, inflow: 0, cleared: "r" },
  { date: "01/05/2013", payee: "Kroger", category: "Everyday Expenses: Groceries", memo: "", outflow: 112.43, inflow: 0, cleared: "c" },
  { date: "01/07/2013", payee: "Shell", category: "Everyday Expenses: Fuel", memo: "", outflow: 48.2, inflow: 0, cleared: "c", flag: "#e8a33d" },
  { date: "01/09/2013", payee: "Target", category: "Split (Multiple Categories)", memo: "Household + spending", outflow: 96.31, inflow: 0, cleared: "c", split: true },
  { date: "01/12/2013", payee: "Transfer: Savings", category: "", memo: "Emergency fund", outflow: 250, inflow: 0, cleared: "c" },
  { date: "01/14/2013", payee: "City Water Dept.", category: "Monthly Bills: Water", memo: "", outflow: 45, inflow: 0, cleared: "u", flag: "#c0483a" },
  { date: "01/16/2013", payee: "Paycheck — Acme Co.", category: "Income for January", memo: "", outflow: 0, inflow: 2410, cleared: "u" },
  { date: "01/18/2013", payee: "Cafe Rio", category: "Everyday Expenses: Restaurants", memo: "lunch w/ Sam", outflow: 18.75, inflow: 0, cleared: "u" },
];

export const Register: React.FC<{ rows?: Txn[]; height?: number }> = ({
  rows = txns,
  height,
}) => {
  const [sel, setSel] = useState(4);
  return (
    <div className="flex flex-col min-h-0" style={height ? { height } : undefined}>
      <div className="y-scroll overflow-auto flex-1">
        <table className="y-table">
          <thead className="y-thead">
            <tr>
              <th style={{ width: 22 }} />
              <th style={{ width: 92 }}>Date</th>
              <th>Payee</th>
              <th style={{ width: 210 }}>Category</th>
              <th style={{ width: 150 }}>Memo</th>
              <th className="num" style={{ width: 92 }}>
                Outflow
              </th>
              <th className="num" style={{ width: 92 }}>
                Inflow
              </th>
              <th style={{ width: 32 }} className="text-center">
                C
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr
                key={i}
                className={cx("y-row", i % 2 === 1 && "alt", sel === i && "is-sel")}
                onClick={() => setSel(i)}
              >
                <td className="text-center">
                  {t.flag && <span className="y-flag" style={{ background: t.flag }} />}
                </td>
                <td className="y-num">{t.date}</td>
                <td className="truncate">
                  {t.split && (
                    <span className="inline-block mr-[5px] align-[-2px]">
                      <Icon name="split" size={12} color="#6d7478" />
                    </span>
                  )}
                  {t.payee}
                </td>
                <td
                  className="truncate"
                  style={{ color: t.category.startsWith("Split") ? "#2f7fb0" : "#5d6467" }}
                >
                  {t.category || <span className="text-[#a9afb3] italic">Transfer</span>}
                </td>
                <td className="truncate text-[#8b9195] italic">{t.memo}</td>
                <td className="num">{t.outflow ? money(t.outflow) : ""}</td>
                <td className="num" style={{ color: "#5c8f2c", fontWeight: t.inflow ? 700 : 400 }}>
                  {t.inflow ? money(t.inflow) : ""}
                </td>
                <td className="text-center">
                  <ClearedFlag state={t.cleared} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RegisterFooter />
    </div>
  );
};

export const RegisterFooter = () => (
  <div
    className="flex items-center gap-5 px-3 py-[6px] text-[11px]"
    style={{
      background: "linear-gradient(#f0f0ed,#e0e0dc)",
      borderTop: "1px solid #c0c0bb",
      boxShadow: "0 1px 0 rgba(255,255,255,.7) inset",
    }}
  >
    {[
      ["Cleared Balance", 2151.06, "#5d6467"],
      ["Uncleared Balance", 267.57, "#5d6467"],
      ["Working Balance", 2418.63, "#33383b"],
    ].map(([l, v, c], i) => (
      <div key={i as number} className="flex items-center gap-[6px]">
        <span className="y-caps">{l as string}</span>
        <span className="y-num font-bold" style={{ color: c as string }}>
          {money(v as number)}
        </span>
        {i < 2 && <span className="text-[#b7bcbf] ml-3">|</span>}
      </div>
    ))}
    <span className="ml-auto y-hint">9 transactions</span>
  </div>
);

export const RegisterToolbar = () => (
  <Toolbar>
    <Button variant="primary" icon={<Icon name="plus" size={11} color="#fff" />}>
      Add Transaction
    </Button>
    <Button icon={<Icon name="edit" size={12} />}>Edit</Button>
    <Button icon={<Icon name="split" size={12} />}>Make Split</Button>
    <Button icon={<Icon name="trash" size={12} />}>Delete</Button>
    <ToolbarSep />
    <Button icon={<Icon name="import" size={12} />}>File-Based Import</Button>
    <Button icon={<Icon name="reconcile" size={12} />}>Reconcile Account</Button>
    <ToolbarSep />
    <Select options={["All Dates", "This Month", "Last 3 Months", "This Year"]} />
    <Select options={["All Categories", "Monthly Bills", "Everyday Expenses"]} />
    <div className="ml-auto flex items-center gap-2">
      <TextField search placeholder="Search register" style={{ width: 168 }} />
    </div>
  </Toolbar>
);

export const BudgetToolbar = () => (
  <Toolbar>
    <MonthNav />
    <ToolbarSep />
    <Button icon={<Icon name="plus" size={11} />}>Add Category</Button>
    <Button icon={<Icon name="note" size={12} />}>Master Category</Button>
    <ToolbarSep />
    <div className="y-seg">
      <Button active>Budget</Button>
      <Button>Show Hidden</Button>
    </div>
    <div className="ml-auto flex items-center gap-2">
      <Button size="sm">Undo</Button>
      <Button size="sm">Redo</Button>
      <TextField search placeholder="Search categories" style={{ width: 156 }} />
    </div>
  </Toolbar>
);

/* ==================================================================
   MODAL
   ================================================================== */
export const Modal: React.FC<{
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  onClose?: () => void;
  inline?: boolean;
}> = ({ title, children, footer, width = 420, onClose, inline }) => {
  const body = (
    <div className="y-modal" style={{ width }}>
      <div className="y-modal-head flex items-center">
        <span>{title}</span>
        <button className="ml-auto text-[#7d8386] hover:text-[#33383b]" onClick={onClose}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="p-4">{children}</div>
      <div className="y-modal-foot">{footer}</div>
    </div>
  );
  if (inline) return body;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center y-scrim" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  );
};
