export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function fmt(n: number): string {
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (n < 0 ? "-$" : "$") + s;
}

export function fmtSigned(n: number): string {
  if (n === 0) return "$0.00";
  return fmt(n);
}

export function num(s: string | number | null | undefined): number {
  if (s == null) return 0;
  const n = typeof s === "number" ? s : parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

export function monthKey(year: number, monthIndex0: number): string {
  return `${year}-${String(monthIndex0 + 1).padStart(2, "0")}`;
}

export function parseMonthKey(key: string): { year: number; month0: number } {
  const [y, m] = key.split("-").map(Number);
  return { year: y ?? 0, month0: (m ?? 1) - 1 };
}

export function monthLabel(key: string): string {
  const { year, month0 } = parseMonthKey(key);
  return `${MONTHS_LONG[month0] ?? ""} ${year}`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Advance an ISO date (YYYY-MM-DD) by one step of the given frequency.
 * Supported frequencies: "weekly", "biweekly", "monthly", "yearly".
 * Anything else falls back to monthly.
 *
 * Monthly and yearly advances clamp the day to the last valid day of the
 * target month — e.g. Jan 31 + 1 month → Feb 28, mirroring how YNAB handles
 * "31st of every month" recurring entries in short months.
 */
export function nextDateFor(frequency: string, iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "biweekly":
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    case "monthly":
    default: {
      const originalDay = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(originalDay, lastDay));
      break;
    }
  }
  return d.toISOString().slice(0, 10);
}
