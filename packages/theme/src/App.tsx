import { useState } from "react";
import {
  Bar,
  Button,
  Checkbox,
  ClearedFlag,
  Icon,
  Notice,
  Panel,
  Pill,
  Select,
  Tabs,
  TextField,
  Toolbar,
  ToolbarSep,
  Tooltip,
  cx,
  money,
} from "./ynab/primitives";
import {
  BudgetHeader,
  BudgetTable,
  BudgetToolbar,
  Inspector,
  Modal,
  MonthNav,
  Register,
  RegisterToolbar,
  Sidebar,
} from "./ynab/blocks";

/* ---------------------------------------------------------------- docs bits */
const NAV = [
  ["overview", "Overview"],
  ["colors", "Color"],
  ["type", "Typography"],
  ["buttons", "Buttons"],
  ["forms", "Form Controls"],
  ["pills", "Pills & Flags"],
  ["feedback", "Feedback"],
  ["chrome", "App Chrome"],
  ["budget", "Budget View"],
  ["register", "Register"],
  ["dialogs", "Dialogs"],
  ["app", "Full Assembly"],
];

const Section: React.FC<{
  id: string;
  title: string;
  desc?: string;
  children: React.ReactNode;
}> = ({ id, title, desc, children }) => (
  <section id={id} className="doc-anchor mb-14">
    <div className="mb-4">
      <h2 className="text-[19px] font-bold text-[#2b3236] tracking-[-0.01em]">{title}</h2>
      {desc && <p className="text-[12.5px] text-[#6d7478] mt-[3px] max-w-[70ch]">{desc}</p>}
    </div>
    {children}
  </section>
);

const Spec: React.FC<{
  label: string;
  code?: string;
  children: React.ReactNode;
  pad?: boolean;
  className?: string;
}> = ({ label, code, children, pad = true, className }) => (
  <div className="mb-5 rounded-[5px] border border-[#cfd2d1] bg-white overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,.06)]">
    <div className="flex items-center gap-2 px-3 py-[6px] bg-[#f4f4f2] border-b border-[#dedeD9] border-b-[#dededa]">
      <span className="y-caps">{label}</span>
      {code && (
        <code className="ml-auto text-[10.5px] text-[#8b9195] font-mono">{code}</code>
      )}
    </div>
    <div className={cx(pad && "p-4", "bg-[#e9e9e7]", className)}>{children}</div>
  </div>
);

const swatches: [string, string, string][] = [
  ["--y-side-top", "#4a5a64", "Sidebar top"],
  ["--y-side-bot", "#313d45", "Sidebar bottom"],
  ["--y-blue", "#2f7fb0", "Selection / links"],
  ["--y-blue-dark", "#1f5c85", "Selection shade"],
  ["--y-green", "#7cb342", "Positive / primary"],
  ["--y-green-dk", "#5c8f2c", "Positive shade"],
  ["--y-red", "#c0483a", "Overspent"],
  ["--y-orange", "#e8a33d", "Warning / cash overspent"],
  ["--y-grey-pill", "#b3bbc0", "Zero balance"],
  ["--y-master", "#d4dde3", "Master category row"],
  ["--y-row-sel", "#cfe3f2", "Selected row"],
  ["--y-app-bg", "#e9e9e7", "App background"],
];

/* ---------------------------------------------------------------- full app */
const FullApp = () => {
  const [view, setView] = useState<"Budget" | "Accounts">("Budget");
  const [cat, setCat] = useState("Groceries");
  return (
    <div className="y-window">
      <div className="y-titlebar">
        <span className="y-traffic" style={{ background: "linear-gradient(#ff8a7d,#e04a3a)" }} />
        <span className="y-traffic" style={{ background: "linear-gradient(#ffd479,#e0a52a)" }} />
        <span className="y-traffic" style={{ background: "linear-gradient(#a6e178,#5fa63a)" }} />
        <span className="mx-auto font-bold text-[11px]">My Budget ~ YNAB</span>
      </div>
      <div className="flex h-[560px]">
        <Sidebar
          active={view === "Budget" ? "Budget" : "Checking"}
          onSelect={(s) => setView(s === "Budget" || s === "Reports" ? "Budget" : "Accounts")}
        />
        <div className="flex-1 min-w-0 flex flex-col bg-white">
          {view === "Budget" ? (
            <>
              <BudgetToolbar />
              <BudgetHeader />
              <div className="flex flex-1 min-h-0">
                <div className="flex-1 min-w-0 overflow-auto y-scroll">
                  <BudgetTable selected={cat} onSelect={setCat} />
                </div>
                <Inspector category={cat} />
              </div>
            </>
          ) : (
            <>
              <div
                className="flex items-end gap-3 px-3 pt-3 pb-2"
                style={{
                  background: "linear-gradient(#f6f6f4,#e7e7e4)",
                  borderBottom: "1px solid #bdbdb8",
                }}
              >
                <div>
                  <div className="text-[16px] font-bold text-[#3b4245] leading-none">
                    Checking
                  </div>
                  <div className="y-hint mt-[3px]">Budget Account · Big Bank</div>
                </div>
                <div className="ml-auto flex items-center gap-3">
                  <div className="y-mathbox">
                    <div className="y-math-label">Cleared</div>
                    <div className="y-math-val">{money(2151.06)}</div>
                  </div>
                  <div className="y-mathbox">
                    <div className="y-math-label">Uncleared</div>
                    <div className="y-math-val">{money(267.57)}</div>
                  </div>
                  <div className="y-atb y-atb--green">
                    <div className="text-[18px] font-bold leading-[1.15] y-num">
                      {money(2418.63)}
                    </div>
                    <div className="text-[9px] font-bold tracking-[.09em] uppercase opacity-90">
                      Working Balance
                    </div>
                  </div>
                </div>
              </div>
              <RegisterToolbar />
              <div className="flex-1 min-h-0">
                <Register />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------- page */
export default function App() {
  const [tab, setTab] = useState("Budget");
  const [modal, setModal] = useState(false);
  const [chk, setChk] = useState(true);
  const [radio, setRadio] = useState("a");

  return (
    <div className="min-h-screen bg-[#e9e9e7]">
      {/* masthead */}
      <header
        className="sticky top-0 z-40"
        style={{
          background: "linear-gradient(#4a5a64,#313d45)",
          borderBottom: "1px solid #212a30",
          boxShadow: "0 1px 0 rgba(255,255,255,.08) inset, 0 2px 8px rgba(0,0,0,.22)",
        }}
      >
        <div className="max-w-[1240px] mx-auto px-5 h-[52px] flex items-center gap-3">
          <div
            className="w-[26px] h-[26px] rounded-[3px] grid place-items-center text-[12px] font-black text-white"
            style={{
              background: "linear-gradient(#96c95c,#5c8f2c)",
              border: "1px solid #43701d",
              boxShadow: "0 1px 0 rgba(255,255,255,.3) inset",
            }}
          >
            Y
          </div>
          <div className="leading-none">
            <div className="text-white font-bold text-[13.5px]">YNAB 4 Web Toolkit</div>
            <div className="text-[9.5px] text-[#8ea0ab] tracking-[.13em] uppercase">
              Component library · v4.3 revival
            </div>
          </div>
          <nav className="ml-auto hidden lg:flex items-center gap-[2px] overflow-x-auto">
            {NAV.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="text-[11px] text-[#cdd6db] hover:text-white px-[7px] py-[5px] rounded-[3px] hover:bg-white/10 whitespace-nowrap"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-[1240px] mx-auto px-5 py-8">
        {/* ---------------- overview ---------------- */}
        <section id="overview" className="doc-anchor mb-14">
          <div className="mb-5 max-w-[74ch]">
            <h1 className="text-[27px] font-bold text-[#2b3236] leading-[1.15] tracking-[-0.015em]">
              Every pixel of YNAB 4, rebuilt for the browser.
            </h1>
            <p className="text-[13px] text-[#5d6467] mt-2">
              A drop-in kit of the Adobe AIR–era interface: the slate rail, the bevelled
              toolbar buttons, the math strip with its big green “Available to Budget” box,
              rounded balance pills, master-category bands, and the cleared/uncleared
              register flags. Everything below is live React + a single hand-written
              stylesheet of tokens.
            </p>
            <div className="flex flex-wrap gap-2 mt-4">
              <Button variant="primary" size="lg" icon={<Icon name="plus" color="#fff" />}>
                Start a Fresh Budget
              </Button>
              <Button size="lg" icon={<Icon name="import" />}>
                Open Existing Budget
              </Button>
              <Button size="lg" variant="flat">
                Read the Method →
              </Button>
            </div>
          </div>
          <FullApp />
        </section>

        {/* ---------------- color ---------------- */}
        <Section
          id="colors"
          title="Color Tokens"
          desc="YNAB 4 leaned on a desaturated slate chrome with three semantic accents: grass green for money you have, brick red for money you've overspent, and amber for cash-overspending warnings. Selection is a mid-blue."
        >
          <Spec label="Palette" code="var(--y-*)">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {swatches.map(([tok, hex, use]) => (
                <div key={tok}>
                  <div className="swatch" style={{ background: hex }} />
                  <div className="mt-[5px] text-[10.5px] font-bold text-[#3f4649]">{use}</div>
                  <div className="text-[10px] font-mono text-[#8b9195]">{hex}</div>
                  <div className="text-[9.5px] font-mono text-[#a9afb3]">{tok}</div>
                </div>
              ))}
            </div>
          </Spec>
          <Spec label="Semantic balance states" code="balanceTone(n)">
            <div className="flex flex-wrap items-center gap-6">
              {[
                [187.12, "Positive — money still available"],
                [0, "Zero — fully spent, on plan"],
                [-43.75, "Negative — overspent this month"],
              ].map(([v, t]) => (
                <div key={t as string} className="flex items-center gap-[10px]">
                  <Pill tone={(v as number) > 0 ? "green" : (v as number) < 0 ? "red" : "grey"}>
                    {money(v as number)}
                  </Pill>
                  <span className="text-[11.5px] text-[#5d6467]">{t as string}</span>
                </div>
              ))}
              <div className="flex items-center gap-[10px]">
                <Pill tone="orange">{money(-12.4)}</Pill>
                <span className="text-[11.5px] text-[#5d6467]">Cash overspending</span>
              </div>
            </div>
          </Spec>
        </Section>

        {/* ---------------- typography ---------------- */}
        <Section
          id="type"
          title="Typography"
          desc="Lucida Grande (with Segoe UI / Tahoma fallbacks) at small desktop-app sizes. Column headers are 10px uppercase with letterspacing and a white text-shadow; figures are tabular."
        >
          <Spec label="Scale">
            <div className="bg-white rounded-[4px] border border-[#d5d5d0] p-4 space-y-3">
              {[
                ["Available to Budget", "20px / 700 / tabular", "text-[20px] font-bold y-num"],
                ["Screen title — Checking", "16px / 700", "text-[16px] font-bold"],
                ["Section heading", "13px / 700", "text-[13px] font-bold"],
                ["Body & table cell", "12px / 400", "text-[12px]"],
                ["Control label / button", "11px / 700", "text-[11px] font-bold"],
                ["COLUMN HEADER", "10px / 700 / .07em caps", "y-caps"],
                ["Hint text", "10.5px / 400", "y-hint"],
              ].map(([sample, meta, cls]) => (
                <div key={meta} className="flex items-baseline gap-4">
                  <div className={cx(cls, "min-w-[280px] text-[#33383b]")}>{sample}</div>
                  <div className="text-[10.5px] font-mono text-[#8b9195]">{meta}</div>
                </div>
              ))}
            </div>
          </Spec>
        </Section>

        {/* ---------------- buttons ---------------- */}
        <Section
          id="buttons"
          title="Buttons"
          desc="The classic AIR bevel: 1px #9ea3a6 border, 3px radius, a white-to-#e3e4e2 vertical gradient, an inset top highlight, and a pressed state that inverts to an inset shadow."
        >
          <Spec label="Variants" code='<Button variant="primary" />'>
            <div className="flex flex-wrap items-center gap-2">
              <Button>Default</Button>
              <Button variant="primary">Primary</Button>
              <Button variant="blue">Selection Blue</Button>
              <Button variant="danger">Delete Account</Button>
              <Button variant="flat">Flat / Link</Button>
              <Button disabled>Disabled</Button>
              <Button active>Pressed / Toggled</Button>
            </div>
          </Spec>
          <Spec label="Sizes & icons" code='size="sm | md | lg"'>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" icon={<Icon name="plus" size={10} />}>
                Small
              </Button>
              <Button icon={<Icon name="edit" />}>Medium</Button>
              <Button size="lg" variant="primary" icon={<Icon name="check" color="#fff" />}>
                Large Primary
              </Button>
              <Button icon={<Icon name="reconcile" />}>Reconcile Account</Button>
              <Button icon={<Icon name="trash" />} />
              <Button icon={<Icon name="gear" />} />
            </div>
          </Spec>
          <Spec label="Segmented group" code='<div className="y-seg">'>
            <div className="y-seg">
              <Button active>Budget</Button>
              <Button>Spending</Button>
              <Button>Net Worth</Button>
              <Button>Income v. Expense</Button>
            </div>
          </Spec>
        </Section>

        {/* ---------------- forms ---------------- */}
        <Section
          id="forms"
          title="Form Controls"
          desc="Inset-shadowed fields, pill-shaped search boxes, native-feeling selects with a CSS caret, and 13px checkboxes that fill with the selection blue."
        >
          <div className="grid md:grid-cols-2 gap-x-5">
            <Spec label="Text, search, select" code="<TextField /> <Select />">
              <div className="flex flex-col gap-3 max-w-[320px]">
                <div>
                  <div className="y-label mb-[4px]">Payee</div>
                  <TextField defaultValue="Kroger" className="w-full" />
                </div>
                <div>
                  <div className="y-label mb-[4px]">Category</div>
                  <Select
                    className="w-full"
                    options={[
                      "Everyday Expenses: Groceries",
                      "Everyday Expenses: Fuel",
                      "Monthly Bills: Electric",
                    ]}
                  />
                </div>
                <div>
                  <div className="y-label mb-[4px]">Search</div>
                  <TextField search placeholder="Search register" className="w-full" />
                </div>
                <div>
                  <div className="y-label mb-[4px]">Amount (inline register style)</div>
                  <div className="bg-white border border-[#d5d5d0] rounded-[3px] p-1 w-[140px]">
                    <input className="y-inline-amt" defaultValue="$112.43" />
                  </div>
                </div>
              </div>
            </Spec>
            <Spec label="Toggles" code="<Checkbox radio />">
              <div className="flex flex-col gap-[10px]">
                <Checkbox checked={chk} onChange={setChk} label="Cleared in this account" />
                <Checkbox checked label="Show running balance" />
                <Checkbox label="Hide categories with zero balance" />
                <div className="y-divider my-1" />
                <Checkbox
                  radio
                  checked={radio === "a"}
                  onChange={() => setRadio("a")}
                  label="Budget account (on-budget)"
                />
                <Checkbox
                  radio
                  checked={radio === "b"}
                  onChange={() => setRadio("b")}
                  label="Tracking account (off-budget)"
                />
                <div className="y-divider my-1" />
                <div className="flex items-center gap-2">
                  <span className="y-label">Flag</span>
                  {["#c0483a", "#e8a33d", "#7cb342", "#2f7fb0", "#8e6bb0", "#b3bbc0"].map((c) => (
                    <span key={c} className="y-flag" style={{ background: c }} />
                  ))}
                </div>
              </div>
            </Spec>
          </div>
        </Section>

        {/* ---------------- pills ---------------- */}
        <Section
          id="pills"
          title="Pills, Flags & Bars"
          desc="The balance pill is YNAB 4's signature: a 10px-radius gradient lozenge with a dark text shadow. Register rows use square C/U/R chips and 10px colour flags."
        >
          <div className="grid md:grid-cols-3 gap-x-5">
            <Spec label="Balance pills" code="<Pill tone />">
              <div className="flex flex-wrap gap-2">
                <Pill tone="green">{money(640)}</Pill>
                <Pill tone="red">{money(-35.35)}</Pill>
                <Pill tone="orange">{money(-12.4)}</Pill>
                <Pill tone="grey">{money(0)}</Pill>
                <Pill tone="blue">{money(1250)}</Pill>
              </div>
            </Spec>
            <Spec label="Cleared state" code="<ClearedFlag state />">
              <div className="flex items-center gap-4">
                {(["c", "u", "r"] as const).map((s) => (
                  <div key={s} className="flex items-center gap-[6px]">
                    <ClearedFlag state={s} />
                    <span className="text-[11px] text-[#5d6467]">
                      {s === "c" ? "Cleared" : s === "u" ? "Uncleared" : "Reconciled"}
                    </span>
                  </div>
                ))}
              </div>
            </Spec>
            <Spec label="Goal progress" code="<Bar pct tone />">
              <div className="space-y-[10px]">
                <Bar pct={92} />
                <Bar pct={54} tone="blue" />
                <Bar pct={28} tone="orange" />
                <Bar pct={100} tone="red" />
              </div>
            </Spec>
          </div>
        </Section>

        {/* ---------------- feedback ---------------- */}
        <Section
          id="feedback"
          title="Feedback & Navigation"
          desc="Notices, tooltips and tab bars in the same bevelled idiom."
        >
          <div className="grid md:grid-cols-2 gap-x-5">
            <Spec label="Notices" code="<Notice tone />">
              <div className="space-y-2">
                <Notice tone="ok" title="Budget balanced">
                  Every dollar in January has a job. Nicely done.
                </Notice>
                <Notice tone="warn" title="Overspent in December">
                  $38.12 of red will be pulled from next month's income.
                </Notice>
                <Notice tone="danger" title="Cash overspending">
                  Cell Phone is $35.35 over and was paid from Checking.
                </Notice>
                <Notice tone="info">
                  Rule Four: Live on last month's income. You're 62% of the way there.
                </Notice>
              </div>
            </Spec>
            <Spec label="Tabs, tooltip, month nav" code="<Tabs /> <Tooltip />">
              <div className="space-y-4">
                <div className="bg-white border border-[#c9c9c5] rounded-[4px] overflow-hidden">
                  <Tabs
                    tabs={["Budget", "Spending", "Net Worth", "Income v. Expense"]}
                    value={tab}
                    onChange={setTab}
                  />
                  <div className="p-4 text-[12px] text-[#5d6467]">
                    Showing <b>{tab}</b> for January 2013.
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Tooltip tip="Rolls overspending onto next month">
                    <Button icon={<Icon name="star" />}>Hover for tooltip</Button>
                  </Tooltip>
                  <MonthNav />
                </div>
              </div>
            </Spec>
          </div>
        </Section>

        {/* ---------------- chrome ---------------- */}
        <Section
          id="chrome"
          title="App Chrome"
          desc="The navigation rail and toolbars. The rail is a vertical slate gradient with text shadowed downward; the selected row gets a blue gradient with an inset shadow and a hairline light top border."
        >
          <div className="grid lg:grid-cols-[auto_1fr] gap-5 items-start">
            <Spec label="Navigation rail" code="<Sidebar />" pad={false}>
              <div className="flex h-[430px]">
                <Sidebar />
              </div>
            </Spec>
            <div>
              <Spec label="Toolbar — budget" code="<BudgetToolbar />" pad={false}>
                <BudgetToolbar />
              </Spec>
              <Spec label="Toolbar — register" code="<RegisterToolbar />" pad={false}>
                <RegisterToolbar />
              </Spec>
              <Spec label="Toolbar — custom composition" code="<Toolbar />" pad={false}>
                <Toolbar>
                  <Button icon={<Icon name="calendar" size={12} />}>Jan 2013</Button>
                  <ToolbarSep />
                  <Button icon={<Icon name="flag" size={12} />}>Flag</Button>
                  <Button icon={<Icon name="lock" size={12} />}>Lock Reconciled</Button>
                  <ToolbarSep />
                  <div className="y-seg">
                    <Button active>All</Button>
                    <Button>Cleared</Button>
                    <Button>Uncleared</Button>
                  </div>
                  <div className="ml-auto">
                    <Button variant="blue" icon={<Icon name="gear" color="#fff" size={12} />}>
                      Settings
                    </Button>
                  </div>
                </Toolbar>
              </Spec>
              <Spec label="Panels" code="<Panel title />">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Panel title="Account Details">
                    <dl className="text-[11.5px] space-y-[5px] text-[#5d6467]">
                      <div className="flex justify-between">
                        <dt>Type</dt>
                        <dd className="font-bold text-[#33383b]">Checking</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>On budget</dt>
                        <dd className="font-bold text-[#33383b]">Yes</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>Last reconciled</dt>
                        <dd className="font-bold text-[#33383b]">12/31/2012</dd>
                      </div>
                    </dl>
                  </Panel>
                  <Panel title="Age of Money">
                    <div className="text-[26px] font-bold text-[#5c8f2c] y-num leading-none">
                      31 days
                    </div>
                    <div className="y-hint mt-1 mb-2">Up 4 days from December</div>
                    <Bar pct={78} />
                  </Panel>
                </div>
              </Spec>
            </div>
          </div>
        </Section>

        {/* ---------------- budget ---------------- */}
        <Section
          id="budget"
          title="Budget View"
          desc="The math strip resolves last month's leftovers and overspending against this month's income and budgeting, landing in the Available to Budget box. Master categories are a banded blue-grey; sub-categories alternate white and #f3f6f8 with inline-editable Budgeted cells."
        >
          <Spec label="Header math strip" code="<BudgetHeader atb />" pad={false}>
            <BudgetHeader />
          </Spec>
          <Spec label="Over-budgeted state" code='atb < 0 → "y-atb--red"' pad={false}>
            <BudgetHeader atb={-124.9} />
          </Spec>
          <Spec label="Budget table + inspector" code="<BudgetTable /> <Inspector />" pad={false}>
            <div className="flex bg-white">
              <div className="flex-1 min-w-0 max-h-[460px] overflow-auto y-scroll">
                <BudgetTable selected="Groceries" />
              </div>
              <Inspector />
            </div>
          </Spec>
        </Section>

        {/* ---------------- register ---------------- */}
        <Section
          id="register"
          title="Account Register"
          desc="Eight columns, zebra striping, a colour-flag gutter, split indicators, inflow in green, and a footer that always shows Cleared / Uncleared / Working balances."
        >
          <Spec label="Register" code="<Register />" pad={false}>
            <div className="bg-white">
              <RegisterToolbar />
              <Register />
            </div>
          </Spec>
        </Section>

        {/* ---------------- dialogs ---------------- */}
        <Section
          id="dialogs"
          title="Dialogs"
          desc="Sheet-style modals with a gradient title bar, a light body and a footer rail of right-aligned buttons."
        >
          <div className="grid lg:grid-cols-2 gap-5 items-start">
            <Spec label="Inline example" code="<Modal inline />">
              <div className="flex justify-center">
                <Modal
                  inline
                  title="Add Account"
                  width={400}
                  footer={
                    <>
                      <Button>Cancel</Button>
                      <Button variant="primary">Create Account</Button>
                    </>
                  }
                >
                  <div className="space-y-3">
                    <div>
                      <div className="y-label mb-[4px]">Account nickname</div>
                      <TextField className="w-full" defaultValue="Checking" />
                    </div>
                    <div>
                      <div className="y-label mb-[4px]">Account type</div>
                      <Select
                        className="w-full"
                        options={["Checking", "Savings", "Credit Card", "Cash", "Investment"]}
                      />
                    </div>
                    <div>
                      <div className="y-label mb-[4px]">Today's balance</div>
                      <TextField className="w-full" defaultValue="$2,418.63" />
                    </div>
                    <div className="y-divider" />
                    <Checkbox checked radio label="Budget account — spending is budgeted" />
                    <Checkbox radio label="Tracking account — assets & loans only" />
                    <Notice tone="info">
                      Starting balances create an “Income for January” transaction.
                    </Notice>
                  </div>
                </Modal>
              </div>
            </Spec>
            <Spec label="Reconcile wizard + overlay trigger">
              <div className="flex justify-center mb-4">
                <Modal
                  inline
                  title="Reconcile Checking"
                  width={380}
                  footer={
                    <>
                      <Button>Cancel</Button>
                      <Button variant="blue" icon={<Icon name="reconcile" color="#fff" size={12} />}>
                        Looks Good
                      </Button>
                    </>
                  }
                >
                  <p className="text-[12px] text-[#5d6467] mb-3">
                    Enter the balance shown on your bank statement. YNAB will create an
                    adjustment transaction if it doesn't match.
                  </p>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="y-label w-[118px]">Statement balance</span>
                    <TextField defaultValue="$2,151.06" className="flex-1" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="y-label w-[118px]">Cleared in YNAB</span>
                    <Pill tone="green">{money(2151.06)}</Pill>
                  </div>
                  <div className="y-divider my-3" />
                  <Notice tone="ok" title="Balances match">
                    No adjustment transaction is needed.
                  </Notice>
                </Modal>
              </div>
              <div className="text-center">
                <Button variant="primary" onClick={() => setModal(true)}>
                  Open a real overlay
                </Button>
              </div>
            </Spec>
          </div>
        </Section>

        {/* ---------------- app ---------------- */}
        <Section
          id="app"
          title="Full Assembly"
          desc="Rail + toolbar + header + table + inspector, in one 560px-tall window. Click Accounts in the rail to switch to the register."
        >
          <FullApp />
        </Section>

        <footer className="pt-6 pb-12 text-[11px] text-[#8b9195] border-t border-[#d5d5d0]">
          YNAB 4 Web Toolkit — an affectionate, unaffiliated recreation of the 2012
          desktop interface. Give every dollar a job.
        </footer>
      </main>

      {modal && (
        <Modal
          title="Delete Category?"
          width={380}
          onClose={() => setModal(false)}
          footer={
            <>
              <Button onClick={() => setModal(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setModal(false)}>
                Delete Category
              </Button>
            </>
          }
        >
          <p className="text-[12px] text-[#5d6467]">
            “Spending Money” has 14 transactions and a balance of{" "}
            <b className="text-[#c0483a]">{money(-43.75)}</b>. Choose a category to move
            those transactions to.
          </p>
          <div className="mt-3">
            <Select
              className="w-full"
              options={[
                "Everyday Expenses: Restaurants",
                "Everyday Expenses: Household Goods",
                "Uncategorized Transactions",
              ]}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
