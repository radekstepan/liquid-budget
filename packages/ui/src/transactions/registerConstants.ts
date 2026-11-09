// Register column sort + virtualization constants.

export const CLEARED_RANK: Record<string, number> = { u: 0, c: 1, r: 2 };

// Flag sort order: unflagged rows first, then the YNAB4 palette order, with
// the read-only duplicate marker last.
export const FLAG_RANK: Record<string, number> = {
  red: 1,
  orange: 2,
  yellow: 3,
  green: 4,
  blue: 5,
  purple: 6,
  duplicate: 7,
};

export const ROW_HEIGHT = 27;
export const OVERSCAN = 15;
