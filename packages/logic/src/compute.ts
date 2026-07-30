/**
 * compute.ts
 *
 * Re-exports the public computation API from budget-engine.ts.
 * This file exists for backward compatibility — consumers that imported
 * `computeGroups` or `summarize` from here continue to work unchanged.
 */
export { computeGroups, summarize } from "./budget-engine.js";
