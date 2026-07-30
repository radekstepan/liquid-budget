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
  // used for outflow which is shown as negative
  if (n === 0) return "$0.00";
  return fmt(n);
}

export function num(s: string | number | null | undefined): number {
  if (s == null) return 0;
  const n = typeof s === "number" ? s : parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

// month key helpers: "YYYY-MM"
export function monthKey(year: number, monthIndex0: number): string {
  return `${year}-${String(monthIndex0 + 1).padStart(2, "0")}`;
}

export function parseMonthKey(key: string): { year: number; month0: number } {
  const [y, m] = key.split("-").map(Number);
  return { year: y, month0: m - 1 };
}

export function monthLabel(key: string): string {
  const { year, month0 } = parseMonthKey(key);
  return `${MONTHS_LONG[month0]} ${year}`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
