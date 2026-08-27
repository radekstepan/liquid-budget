import { BudgetAppShell } from "@/components/BudgetAppShell";
import { isValidISOMonth } from "@ynab/logic";

export const dynamic = "force-dynamic";

export default async function AppPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  let initialView = "budget";
  let initialMonth: string | undefined;
  let initialAccount: number | undefined;

  if (slug && slug.length > 0) {
    const first = slug[0];
    if (first) {
      const validViews = ["budget", "reports", "calendar", "projections", "transactions", "recurring"];
      if (validViews.includes(first)) {
        initialView = first;
        if (first === "budget" && slug[1] && isValidISOMonth(slug[1])) {
          initialMonth = slug[1];
        }
        if (first === "transactions" && slug[1]) {
          const id = Number(slug[1]);
          if (!Number.isNaN(id)) initialAccount = id;
        }
      }
    }
  }

  return (
    <BudgetAppShell
      initialView={initialView}
      initialMonth={initialMonth}
      initialAccount={initialAccount}
    />
  );
}
