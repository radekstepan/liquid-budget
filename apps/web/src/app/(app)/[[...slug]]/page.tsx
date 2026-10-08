import type { Metadata } from "next";
import { BudgetAppShell } from "@/components/BudgetAppShell";
import {
  buildPageTitle,
  isValidISOMonth,
  todayISO,
  type AppView,
} from "@ynab/logic";
import { getDefaultDb, listAccounts } from "@ynab/server";

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
  const { view, month, accountId } = parseSlug(slug);
  let accountName: string | null = null;
  if (view === "transactions" && accountId != null) {
    try {
      const accounts = await listAccounts(getDefaultDb());
      accountName = accounts.find((a) => a.id === accountId)?.name ?? null;
    } catch {
      // Fall through to the view-level title; the client takes over on
      // hydration and resolves the account name from the loaded budget.
    }
  }
  return {
    title: buildPageTitle(view, {
      // The client defaults a month-less budget URL to today.
      month: view === "budget" ? (month ?? todayISO().slice(0, 7)) : undefined,
      accountName,
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
