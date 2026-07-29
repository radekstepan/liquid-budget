import { describe, expect, it, beforeEach } from "vitest";
import { upsertAssignment } from "../src/queries/assignments.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("upsertAssignment", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  it("updates when an existing row is found", async () => {
    mock.respondWith("select:assignments", [{ id: 42, categoryId: 1, month: "2025-07", amount: "10.00" }]);
    mock.respondWith("update:assignments", [{ id: 42, categoryId: 1, month: "2025-07", amount: "20.00" }]);

    const result = await upsertAssignment(mock.db, { categoryId: 1, month: "2025-07", amount: 20 });
    expect(result).toMatchObject({ id: 42, amount: "20.00" });

    const ops = mock.calls.map((c) => c.op);
    expect(ops).toEqual(["select", "update"]);
  });

  it("inserts when no existing row", async () => {
    mock.respondWith("select:assignments", []);
    mock.respondWith("insert:assignments", [{ id: 99, categoryId: 1, month: "2025-07", amount: "20.00" }]);

    const result = await upsertAssignment(mock.db, { categoryId: 1, month: "2025-07", amount: 20 });
    expect(result).toMatchObject({ id: 99 });

    const ops = mock.calls.map((c) => c.op);
    expect(ops).toEqual(["select", "insert"]);
  });
});
