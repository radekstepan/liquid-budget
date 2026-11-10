import { describe, expect, it } from "vitest";
import { apiErrorResponse } from "../src/app/api/errors";
import { TransactionError } from "@ynab/server";

describe("apiErrorResponse", () => {
  it("preserves domain error messages with their status", async () => {
    const res = apiErrorResponse(new TransactionError("nope", 422));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "nope" });
  });

  it("returns a generic message for unknown errors (no PII/stack leak)", async () => {
    const res = apiErrorResponse(new Error("secret sqlite path /home/user/budget.db"));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(json)).not.toContain("secret");
  });
});
