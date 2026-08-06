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

type _Token = { kind: "num"; value: number } | { kind: "op"; op: string };

const _VALID = /^[-+*/().\d\s]+$/;

export function evalAmount(
  s: string | number | null | undefined,
): number | null {
  if (s == null) return null;
  const raw = typeof s === "number" ? String(s) : s;
  const stripped = raw.replace(/[$,_]/g, "");
  if (stripped.replace(/\s+/g, "") === "") return null;
  if (!_VALID.test(stripped)) return null;

  const isDigit = (ch: string | undefined): ch is string =>
    typeof ch === "string" && ch >= "0" && ch <= "9";
  const isBinOp = (ch: string | undefined): ch is string =>
    ch === "+" || ch === "-" || ch === "*" || ch === "/";

  const tokens: _Token[] = [];
  let i = 0;
  let lastEmitted: "num" | "op" | null = null;
  while (i < stripped.length) {
    const c = stripped[i] as string;
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "(") {
      if (lastEmitted === "num") return null;
      tokens.push({ kind: "op", op: c });
      lastEmitted = "op";
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "op", op: c });
      lastEmitted = "op";
      i++;
      continue;
    }
    if (isBinOp(c)) {
      const lastTok = tokens[tokens.length - 1];
      const lastOp =
        lastEmitted === "op" && lastTok?.kind === "op" ? lastTok.op : null;
      const isUnary =
        c === "-" &&
        (lastEmitted === null ||
          lastOp === "(" ||
          lastOp === "+" ||
          lastOp === "-" ||
          lastOp === "*" ||
          lastOp === "/");
      if (isUnary) {
        i++;
        let num = "";
        let sawDot = false;
        while (i < stripped.length) {
          const cc = stripped[i] as string;
          if (isDigit(cc)) {
            num += cc;
            i++;
          } else if (cc === "." && !sawDot) {
            num += cc;
            sawDot = true;
            i++;
          } else if (cc === " " || cc === "\t" || cc === "\n") {
            i++;
          } else {
            break;
          }
        }
        if (num === "" || num === ".") return null;
        const v = Number(num);
        if (!Number.isFinite(v)) return null;
        tokens.push({ kind: "num", value: -v });
        lastEmitted = "num";
        continue;
      }
      if (lastOp === "+" || lastOp === "-" || lastOp === "*" || lastOp === "/") return null;
      tokens.push({ kind: "op", op: c });
      lastEmitted = "op";
      i++;
      continue;
    }
    if (isDigit(c)) {
      if (lastEmitted === "num") return null;
      let num = "";
      let sawDot = false;
      while (i < stripped.length) {
        const cc = stripped[i] as string;
        if (isDigit(cc)) {
          num += cc;
          i++;
        } else if (cc === "." && !sawDot) {
          num += cc;
          sawDot = true;
          i++;
        } else {
          break;
        }
      }
      const v = Number(num);
      if (!Number.isFinite(v)) return null;
      tokens.push({ kind: "num", value: v });
      lastEmitted = "num";
      continue;
    }
    if (c === ".") {
      if (lastEmitted === "num") return null;
      const next = stripped[i + 1];
      if (isDigit(next)) {
        let num = "0.";
        i++;
        while (i < stripped.length) {
          const cc = stripped[i] as string;
          if (isDigit(cc)) {
            num += cc;
            i++;
          } else {
            break;
          }
        }
        const v = Number(num);
        if (!Number.isFinite(v)) return null;
        tokens.push({ kind: "num", value: v });
        lastEmitted = "num";
        continue;
      }
      return null;
    }
    return null;
  }

  const out: _Token[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
  for (const t of tokens) {
    if (t.kind === "num") {
      out.push(t);
    } else {
      if (t.op === "(") {
        ops.push(t.op);
      } else if (t.op === ")") {
        let found = false;
        while (ops.length) {
          const top = ops.pop();
          if (top === undefined) break;
          if (top === "(") {
            found = true;
            break;
          }
          out.push({ kind: "op", op: top });
        }
        if (!found) return null;
      } else {
        while (
          ops.length > 0 &&
          ops[ops.length - 1] !== "(" &&
          (prec[ops[ops.length - 1] as string] ?? 0) >= (prec[t.op] ?? 0)
        ) {
          const popped = ops.pop();
          if (popped === undefined) break;
          out.push({ kind: "op", op: popped });
        }
        ops.push(t.op);
      }
    }
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === undefined) break;
    if (op === "(") return null;
    out.push({ kind: "op", op });
  }

  const stack: number[] = [];
  for (const t of out) {
    if (t.kind === "num") {
      stack.push(t.value);
    } else {
      if (stack.length < 2) return null;
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return null;
      let r: number;
      if (t.op === "+") r = a + b;
      else if (t.op === "-") r = a - b;
      else if (t.op === "*") r = a * b;
      else r = a / b;
      if (!Number.isFinite(r)) return null;
      stack.push(r);
    }
  }
  if (stack.length !== 1) return null;
  return stack[0] as number;
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
  // Use the local timezone, not UTC. `toISOString()` always renders
  // in UTC, which would silently post-date a transaction entered late
  // in the evening in a westerly timezone (e.g. 9 PM PST on Aug 5 is
  // already Aug 6 UTC). Offset by the local tz delta, then slice the
  // now-local "YYYY-MM-DD" prefix.
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
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
