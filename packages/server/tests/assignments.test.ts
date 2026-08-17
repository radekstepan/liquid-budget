import { describe, expect, it, beforeEach } from "vitest";
import { upsertAssignment } from "../src/queries/assignments.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("upsertAssignment", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  it("atomically inserts or updates assignment using onConflictDoUpdate in a transaction", async () => {
    mock.respondWith("insert:assignments", [{ id: 42, categoryId: 1, month: "2025-07", amount: "20.00" }]);

    const result = await upsertAssignment(mock.db, { categoryId: 1, month: "2025-07", amount: 20 });
    expect(result).toMatchObject({ id: 42, amount: "20.00" });

    const ops = mock.calls.map((c) => c.op);
    expect(ops).toEqual(["run", "insert", "run"]);
  });
});
