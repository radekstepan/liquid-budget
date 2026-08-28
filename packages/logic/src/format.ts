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

export function fmt(cents: number): string {
  const rounded = Math.round(cents);
  if (rounded === 0) return "$0.00";
  const abs = Math.abs(rounded) / 100;
  const s = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (rounded < 0 ? "-$" : "$") + s;
}

export function fmtSigned(cents: number): string {
  if (Math.round(cents) === 0) return "$0.00";
  return fmt(cents);
}

export function num(s: string | number | null | undefined): number {
  if (s == null) return 0;
  if (typeof s === "number") {
    if (Number.isNaN(s) || s === 0 || !Number.isFinite(s)) return 0;
    const sign = s < 0 ? -1 : 1;
    const rounded = sign * Math.round(Math.abs(s));
    if (!Number.isSafeInteger(rounded)) {
      throw new RangeError(`Amount ${s} exceeds safe integer range`);
    }
    return rounded === 0 ? 0 : rounded;
  }
  let str = String(s).trim();
  if (!str) return 0;

  let sign = 1;
  if (str.startsWith("(") && str.endsWith(")")) {
    sign = -1;
    str = str.slice(1, -1).trim();
  } else if (str.startsWith("-")) {
    sign = -1;
    str = str.slice(1).trim();
  } else if (str.startsWith("+")) {
    str = str.slice(1).trim();
  }

  // Strip currency symbols, commas, spaces, underscores
  str = str.replace(/[$€£¥,_ \t]/g, "");

  // Handle minus sign after currency symbol e.g. "$-500"
  if (str.startsWith("-")) {
    sign = -1 * sign;
    str = str.slice(1).trim();
  }

  const rawNum = Number(str);
  if (Number.isNaN(rawNum) || rawNum === 0 || !Number.isFinite(rawNum)) return 0;
  const rounded = Math.round(Math.abs(rawNum));
  const finalVal = sign * rounded;
  if (!Number.isSafeInteger(finalVal)) {
    throw new RangeError(`Amount ${finalVal} exceeds safe integer range`);
  }
  return finalVal === 0 ? 0 : finalVal;
}

/**
 * Strict parser for integer cents values.
 * Throws TypeError or RangeError on non-integer, unparseable, or overflow input.
 */
export function numCents(
  s: string | number | null | undefined,
  options?: { allowZero?: boolean }
): number {
  const allowZero = options?.allowZero ?? true;
  if (s == null) {
    if (!allowZero) throw new RangeError("Amount cannot be zero");
    return 0;
  }

  if (typeof s === "number") {
    if (Number.isNaN(s) || !Number.isFinite(s)) {
      throw new TypeError(`Invalid integer cents value: ${s}`);
    }
    if (!Number.isSafeInteger(s)) {
      if (Math.abs(s) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`Amount ${s} exceeds safe integer range`);
      }
      throw new TypeError(`Amount must be an integer cents value: ${s}`);
    }
    if (!allowZero && s === 0) {
      throw new RangeError("Amount cannot be zero");
    }
    return s;
  }

  let str = String(s).trim();
  if (!str) {
    if (!allowZero) throw new RangeError("Amount cannot be zero");
    return 0;
  }

  let sign = 1;
  if (str.startsWith("(") && str.endsWith(")")) {
    sign = -1;
    str = str.slice(1, -1).trim();
  } else if (str.startsWith("-")) {
    sign = -1;
    str = str.slice(1).trim();
  } else if (str.startsWith("+")) {
    sign = 1;
    str = str.slice(1).trim();
  }

  // Strip currency symbols, commas, spaces, underscores
  str = str.replace(/[$€£¥,_ \t]/g, "");

  // Handle minus sign after currency symbol e.g. "$-500"
  if (str.startsWith("-")) {
    sign = -1 * sign;
    str = str.slice(1).trim();
  } else if (str.startsWith("+")) {
    str = str.slice(1).trim();
  }

  if (!str) {
    throw new TypeError(`Invalid integer cents value: ${s}`);
  }

  if (str.includes(".")) {
    const parts = str.split(".");
    if (parts.length !== 2 || !/^\d*$/.test(parts[0]!) || !/^\d*$/.test(parts[1]!)) {
      throw new TypeError(`Invalid integer cents value: ${s}`);
    }
    // If decimal part contains non-zero digits, reject as lossy float cents
    if (parts[1] && !/^0+$/.test(parts[1])) {
      throw new TypeError(`Invalid integer cents value (contains decimal): ${s}`);
    }
    str = parts[0] || "0";
  }

  if (!/^\d+$/.test(str)) {
    throw new TypeError(`Invalid integer cents value: ${s}`);
  }

  const rawNum = Number(str);
  if (!Number.isSafeInteger(rawNum)) {
    throw new RangeError(`Amount ${s} exceeds safe integer range`);
  }

  const finalVal = sign * rawNum;
  if (!allowZero && finalVal === 0) {
    throw new RangeError("Amount cannot be zero");
  }
  return finalVal === 0 ? 0 : finalVal;
}

export function dollarsToCents(d: number | string | null | undefined): number {
  if (d == null) return 0;
  const n = typeof d === "number" ? d : Number(d);
  if (Number.isNaN(n) || n === 0 || !Number.isFinite(n)) return 0;

  if (Math.abs(n) * 100 > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Amount ${d} exceeds safe integer range`);
  }

  const sign = n < 0 ? -1 : 1;
  const absStr = String(Math.abs(n));
  let scaled: number;
  if (absStr.includes("e") || absStr.includes("E")) {
    scaled = Math.abs(n) * 100;
  } else {
    scaled = Number(`${absStr}e2`);
  }

  const c = sign * Math.round(scaled);
  if (!Number.isSafeInteger(c)) {
    throw new RangeError(`Amount ${d} exceeds safe integer range`);
  }
  return c === 0 ? 0 : c;
}

type _Token = { kind: "num"; value: number } | { kind: "op"; op: string };

const _VALID = /^[-+*/().\d\s]+$/;

export function evalAmount(
  s: string | number | null | undefined,
): number | null {
  if (s == null) return null;
  const raw = typeof s === "number" ? String(s) : s;
  const stripped = raw
    .replace(/[$€£¥_]/g, "")
    .replace(/,(\d{1,2})(?!\d)/g, ".$1")
    .replace(/,/g, "");
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
      if (!Number.isFinite(r) || Math.abs(r) > Number.MAX_SAFE_INTEGER) return null;
      stack.push(r);
    }
  }
  if (stack.length !== 1) return null;
  const finalVal = stack[0] as number;
  if (!Number.isFinite(finalVal) || Math.abs(finalVal) > Number.MAX_SAFE_INTEGER) return null;
  return finalVal;
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

export function nextMonthKey(key: string): string {
  const { year, month0 } = parseMonthKey(key);
  if (month0 === 11) {
    return monthKey(year + 1, 0);
  }
  return monthKey(year, month0 + 1);
}

export function prevMonthKey(key: string): string {
  const { year, month0 } = parseMonthKey(key);
  if (month0 === 0) {
    return monthKey(year - 1, 11);
  }
  return monthKey(year, month0 - 1);
}

export const previousMonthKey = prevMonthKey;

export function round2(n: number): number {
  return dollarsToCents(n) / 100;
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

export function isValidISODate(str: unknown): str is string {
  if (typeof str !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return false;
  const y = parseInt(m[1]!, 10);
  const mo = parseInt(m[2]!, 10);
  const d = parseInt(m[3]!, 10);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

export function isValidISOMonth(str: unknown): str is string {
  if (typeof str !== "string") return false;
  const m = /^(\d{4})-(\d{2})$/.exec(str);
  if (!m) return false;
  const y = parseInt(m[1]!, 10);
  const mo = parseInt(m[2]!, 10);
  if (y < 1 || mo < 1 || mo > 12) return false;
  return true;
}

/**
 * Advance an ISO date (YYYY-MM-DD) by one step of the given frequency.
 * Supported frequencies: "daily", "weekly", "biweekly", "twiceamonth",
 * "every4weeks", "monthly", "everyothermonth", "every3months", "every4months",
 * "twiceayear", "yearly", "every2years".
 * Anything else falls back to monthly.
 *
 * Monthly and yearly advances clamp the day to the last valid day of the
 * target month — e.g. Jan 31 + 1 month → Feb 28, mirroring how YNAB handles
 * "31st of every month" recurring entries in short months.
 *
 * When `anchor` is provided (day of month 1..31 or ISO date string), month-based
 * advances clamp against the anchor day rather than the previous output string,
 * preventing permanent schedule drift after February or shorter months (BUG-06).
 */
export function nextDateFor(
  frequency: string,
  iso: string,
  anchor?: number | string
): string {
  if (!isValidISODate(iso)) return iso;
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;

  let anchorDay: number;
  if (typeof anchor === "number" && !Number.isNaN(anchor) && anchor >= 1 && anchor <= 31) {
    anchorDay = Math.floor(anchor);
  } else if (typeof anchor === "string" && isValidISODate(anchor)) {
    anchorDay = parseInt(anchor.slice(8, 10), 10);
  } else if (typeof anchor === "string" && /^\d+$/.test(anchor)) {
    anchorDay = Math.min(31, Math.max(1, parseInt(anchor, 10)));
  } else {
    anchorDay = d.getUTCDate();
  }

  const norm = (frequency || "").toLowerCase().replace(/[\s_-]+/g, "");
  switch (norm) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "biweekly":
    case "everyotherweek":
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case "twiceamonth":
    case "semimonthly": {
      const d1 = anchorDay <= 15 ? anchorDay : anchorDay - 15;
      const d2 = anchorDay <= 15 ? anchorDay + 15 : anchorDay;
      const currentDay = d.getUTCDate();
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      const clampedD2 = Math.min(d2, lastDay);
      const isFirstHalf = currentDay < clampedD2;

      if (isFirstHalf) {
        d.setUTCDate(clampedD2);
      } else {
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() + 1);
        d.setUTCDate(d1);
      }
      break;
    }
    case "every4weeks":
      d.setUTCDate(d.getUTCDate() + 28);
      break;
    case "everyothermonth":
    case "bimonthly": {
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 2);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      d.setUTCDate(Math.min(anchorDay, lastDay));
      break;
    }
    case "every3months":
    case "quarterly": {
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 3);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      d.setUTCDate(Math.min(anchorDay, lastDay));
      break;
    }
    case "every4months": {
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 4);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      d.setUTCDate(Math.min(anchorDay, lastDay));
      break;
    }
    case "twiceayear":
    case "semiannually": {
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 6);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      d.setUTCDate(Math.min(anchorDay, lastDay));
      break;
    }
    case "every2years":
    case "everyotheryear": {
      d.setUTCDate(1);
      d.setUTCFullYear(d.getUTCFullYear() + 2);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      d.setUTCDate(Math.min(anchorDay, lastDay));
      break;
    }
    case "yearly":
    case "annually": {
      d.setUTCDate(1);
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      d.setUTCDate(Math.min(anchorDay, lastDay));
      break;
    }
    case "monthly":
    default: {
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
      ).getUTCDate();
      d.setUTCDate(Math.min(anchorDay, lastDay));
      break;
    }
  }
  return d.toISOString().slice(0, 10);
}

/**
 * YNAB4 Date Keyboard Shortcuts:
 *   `+` or `=`: +1 day
 *   `-` or `_`: -1 day
 *   `t` or `T`: today
 *   `m` or `M`: +1 month
 *   `y` or `Y`: +1 year
 */
export function adjustDateShortcut(dateStr: string, key: string): string | null {
  if (key.toLowerCase() === "t") return todayISO();
  if (!isValidISODate(dateStr)) {
    return null;
  }

  const [yStr, mStr, dStr] = dateStr.split("-");
  const y = parseInt(yStr!, 10);
  const m = parseInt(mStr!, 10) - 1;
  const d = parseInt(dStr!, 10);

  const date = new Date(Date.UTC(y, m, d));
  if (Number.isNaN(date.getTime())) return null;

  switch (key) {
    case "+":
    case "=": {
      date.setUTCDate(date.getUTCDate() + 1);
      break;
    }
    case "-":
    case "_": {
      date.setUTCDate(date.getUTCDate() - 1);
      break;
    }
    case "m":
    case "M": {
      const originalDay = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + 1);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(originalDay, lastDay));
      break;
    }
    case "y":
    case "Y": {
      const originalDay = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCFullYear(date.getUTCFullYear() + 1);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(originalDay, lastDay));
      break;
    }
    default:
      return null;
  }

  return date.toISOString().slice(0, 10);
}
