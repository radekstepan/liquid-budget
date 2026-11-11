import type { Metadata } from "next";
import { BudgetAppShell } from "@/components/BudgetAppShell";
import {
  buildPageTitle,
  isValidISOMonth,
  todayISO,
  type AppView,
} from "@ynab/logic";

export const dynamic = "force-dynamic";

const VALID_VIEWS: AppView[] = ["budget", "reports", "transactions"];

function parseSlug(slug?: string[]): {
  view: AppView;
  month?: string;
  accountId?: number;
} {
  if (slug && slug.length > 0) {
    const first = slug[0];
    if (first && (VALID_VIEWS as string[]).includes(first)) {
      const view = first as AppView;
      if (view === "budget" && slug[1] && isValidISOMonth(slug[1])) {
        return { view, month: slug[1] };
      }
      if (view === "transactions" && slug[1]) {
        const id = Number(slug[1]);
        if (!Number.isNaN(id)) return { view, accountId: id };
      }
      return { view };
    }
  }
  return { view: "budget" };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // No DB I/O here by design: opening SQLite from RSC couples rendering to
  // the connection lifecycle (and breaks on DB failure). The transactions
  // view gets a generic pre-hydration title; BudgetApp resolves the account
  // name client-side via document.title on hydration.
  const { view, month } = parseSlug(slug);
  return {
    title: buildPageTitle(view, {
      // The client defaults a month-less budget URL to today.
      month: view === "budget" ? (month ?? todayISO().slice(0, 7)) : undefined,
      accountName: null,
    }),
    description: "A zero-based envelope budgeting app. A YNAB4 alternative.",
  };
}

export default async function AppPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const { view, month, accountId } = parseSlug(slug);

  return (
    <BudgetAppShell
      initialView={view}
      initialMonth={month}
      initialAccount={accountId}
    />
  );
}
