import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createOptimisticMutation,
  reportBudgetReloadFailure,
  type OptimisticMutationShell,
} from "../src/components/api/optimistic-mutation";

function makeShell(opts?: { reloadImpl?: () => Promise<void> }) {
  const order: string[] = [];
  const reloadCalls: unknown[][] = [];
  const runMutationArgs: { opts: { skipReload?: boolean } | undefined }[] = [];
  const reload: OptimisticMutationShell["reload"] = async () => {
    reloadCalls.push([]);
    order.push("reload");
    await opts?.reloadImpl?.();
  };
  const addToast = vi.fn(() => ({ id: 1 }) as never);
  const runMutation: OptimisticMutationShell["runMutation"] = async (
    action,
    messages,
    mOpts
  ) => {
    runMutationArgs.push({ opts: mOpts });
    order.push(`runMutation(skipReload=${mOpts?.skipReload ?? false})`);
    try {
      const result = await action();
      if (messages.success) order.push("toast:success");
      if (!mOpts?.skipReload) {
        await reload();
      }
      return result;
    } catch (e) {
      order.push("toast:failure");
      mOpts?.onRollback?.();
      throw e;
    }
  };
  const withSync: OptimisticMutationShell["withSync"] = async (fn) => {
    order.push("withSync:start");
    try {
      return await fn();
    } finally {
      order.push("withSync:end");
    }
  };
  const optimisticMutation = createOptimisticMutation({ reload, runMutation, withSync, addToast });
  return { reloadCalls, runMutationArgs, addToast, optimisticMutation, order };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOptimisticMutation", () => {
  it("applies plan before the request, maps the result, and reloads on success", async () => {
    const shell = makeShell();
    const order: string[] = [];
    const result = await shell.optimisticMutation({
      plan: () => {
        order.push("plan");
      },
      request: async () => {
        order.push("request");
        return { id: 42 };
      },
      mapResult: (res) => {
        order.push(`mapResult:${res.id}`);
      },
      messages: { success: "Saved.", failure: "Failed." },
    });

    expect(result).toEqual({ id: 42 });
    expect(order).toEqual(["plan", "request", "mapResult:42"]);
    expect(shell.order).toEqual([
      "withSync:start",
      "runMutation(skipReload=false)",
      "toast:success",
      "reload",
      "withSync:end",
    ]);
  });

  it("runs rollback then a silent confirming reload when the request fails", async () => {
    const shell = makeShell();
    const order: string[] = [];
    const failure = new Error("nope");
    await expect(
      shell.optimisticMutation({
        plan: () => {
          order.push("plan");
        },
        request: async () => {
          order.push("request");
          throw failure;
        },
        messages: { failure: "Failed." },
        rollback: () => {
          order.push("rollback");
        },
      })
    ).rejects.toThrow("nope");

    expect(order).toEqual(["plan", "request", "rollback"]);
    // Failure path: no success toast, rollback restore followed by the
    // helper's silent confirming reload (no addToast warn on this path).
    expect(shell.order).toEqual([
      "withSync:start",
      "runMutation(skipReload=false)",
      "toast:failure",
      "reload",
      "withSync:end",
    ]);
    expect(shell.addToast).not.toHaveBeenCalled();
  });

  it("skips the confirming reload when no rollback is provided", async () => {
    const shell = makeShell();
    await expect(
      shell.optimisticMutation({
        request: async () => {
          throw new Error("boom");
        },
        messages: { failure: "Failed." },
      })
    ).rejects.toThrow("boom");

    expect(shell.order).toEqual([
      "withSync:start",
      "runMutation(skipReload=false)",
      "toast:failure",
      "withSync:end",
    ]);
  });

  it("honors skipReload on success without an extra reload", async () => {
    const shell = makeShell();
    const result = await shell.optimisticMutation({
      request: async () => "ok",
      messages: { failure: "Failed." },
      rollback: () => {},
      skipReload: true,
    });

    expect(result).toBe("ok");
    expect(shell.reloadCalls).toHaveLength(0);
    expect(shell.runMutationArgs).toEqual([{ opts: expect.objectContaining({ skipReload: true }) }]);
  });

  it("deferredReload resolves with the result and reloads detached", async () => {
    const shell = makeShell();
    const result = await shell.optimisticMutation({
      plan: () => {},
      request: async () => ({ adjustmentTransactionId: 7 }),
      mapResult: () => {},
      messages: { success: "Reconciled.", failure: "Failed." },
      rollback: () => {},
      deferredReload: true,
    });

    expect(result).toEqual({ adjustmentTransactionId: 7 });
    expect(shell.runMutationArgs).toEqual([
      { opts: expect.objectContaining({ skipReload: true }) },
    ]);
    expect(shell.reloadCalls).toHaveLength(1);
    expect(shell.addToast).not.toHaveBeenCalled();
  });

  it("deferredReload reports a stale confirming reload but still resolves", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const shell = makeShell({
      reloadImpl: async () => {
        throw new Error("stale");
      },
    });
    const result = await shell.optimisticMutation({
      request: async () => 1,
      messages: { success: "Reconciled.", failure: "Failed." },
      deferredReload: true,
    });

    expect(result).toBe(1);
    // The detached reload rejects; flush the .catch continuation.
    for (let i = 0; i < 10 && shell.addToast.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(consoleSpy).toHaveBeenCalledWith(
      "Budget reload failed after successful mutation:",
      expect.objectContaining({ message: "stale" })
    );
    expect(shell.addToast).toHaveBeenCalledWith(
      "Saved changes, but failed to refresh latest budget data.",
      "warn"
    );
    consoleSpy.mockRestore();
  });

  it("reportBudgetReloadFailure logs once and raises the stale-read warning", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const addToast = vi.fn();
    const err = new Error("gone");
    reportBudgetReloadFailure(err, addToast as never);

    expect(consoleSpy).toHaveBeenCalledWith(
      "Budget reload failed after successful mutation:",
      err
    );
    expect(addToast).toHaveBeenCalledWith(
      "Saved changes, but failed to refresh latest budget data.",
      "warn"
    );
    consoleSpy.mockRestore();
  });
});
