import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  isLoopbackHost,
  isLoopbackIp,
  isLoopbackRequest,
  mutationGuardResponse,
} from "../src/app/api/guard";

vi.stubEnv("DATABASE_URL", ":memory:");

function req(url: string, headers: Record<string, string> = {}): Request {
  return new NextRequest(url, { method: "POST", headers });
}

describe("loopback mutation guard (P0 auth-hardening)", () => {
  beforeEach(() => {
    vi.stubEnv("ALLOW_NON_LOOPBACK_MUTATIONS", "");
  });

  it("treats localhost / 127.x / ::1 as loopback", () => {
    expect(isLoopbackIp("localhost")).toBe(true);
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("127.0.0.2")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("[::1]")).toBe(true);
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost:3000")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3100")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
  });

  it("rejects external IPs and hosts", () => {
    expect(isLoopbackIp("192.168.1.10")).toBe(false);
    expect(isLoopbackIp("10.0.0.5")).toBe(false);
    expect(isLoopbackIp("203.0.113.7")).toBe(false);
    expect(isLoopbackIp("::ffff:192.168.1.10")).toBe(false);
    expect(isLoopbackHost("192.168.1.10:3000")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("allows loopback URLs with no proxy headers", () => {
    expect(mutationGuardResponse(req("http://localhost:3000/api/transactions"))).toBeNull();
    expect(mutationGuardResponse(req("http://127.0.0.1:3100/api/export"))).toBeNull();
    expect(mutationGuardResponse(req("http://[::1]:3000/api/reset"))).toBeNull();
  });

  it("blocks LAN hosts with no proxy headers", async () => {
    const blocked = mutationGuardResponse(req("http://192.168.1.10:3000/api/transactions"));
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(403);
    const json = await blocked!.json();
    expect(json.error).toMatch(/localhost/i);
  });

  it("lets x-forwarded-for win over a loopback Host (spoof-aware)", async () => {
    const spoofed = mutationGuardResponse(
      req("http://localhost:3000/api/transactions", { "x-forwarded-for": "203.0.113.7" })
    );
    expect(spoofed).not.toBeNull();
    expect(spoofed!.status).toBe(403);

    const viaLoopbackProxy = mutationGuardResponse(
      req("http://192.168.1.10:3000/api/transactions", { "x-forwarded-for": "127.0.0.1" })
    );
    expect(viaLoopbackProxy).toBeNull();
  });

  it("honours x-real-ip and multi-entry x-forwarded-for", () => {
    expect(
      mutationGuardResponse(req("http://localhost/api/x", { "x-real-ip": "10.0.0.5" }))
    ).not.toBeNull();
    expect(
      mutationGuardResponse(
        req("http://localhost/api/x", { "x-forwarded-for": "203.0.113.1, 70.41.3.18" })
      )
    ).not.toBeNull();
    expect(
      mutationGuardResponse(req("http://localhost/api/x", { "x-real-ip": "127.0.0.1" }))
    ).toBeNull();
  });

  it("allows in-process calls with no Request (unit-test direct handler use)", () => {
    expect(mutationGuardResponse(undefined)).toBeNull();
    expect(isLoopbackRequest(new Request("http://localhost/api/x"))).toBe(true);
  });

  it("bypasses the guard when ALLOW_NON_LOOPBACK_MUTATIONS=true", () => {
    vi.stubEnv("ALLOW_NON_LOOPBACK_MUTATIONS", "true");
    expect(
      mutationGuardResponse(req("http://192.168.1.10:3000/api/transactions"))
    ).toBeNull();
    expect(
      mutationGuardResponse(
        req("http://localhost/api/x", { "x-forwarded-for": "203.0.113.7" })
      )
    ).toBeNull();
  });

  it("blocks a real mutating handler from a LAN host", async () => {
    const { POST } = await import("../src/app/api/duplicates/route");
    const res = await POST(new Request("http://192.168.1.10:3000/api/duplicates", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("keeps reset() callable with no args for existing unit tests", async () => {
    const { POST } = await import("../src/app/api/reset/route");
    vi.stubEnv("NODE_ENV", "test");
    const res = await POST();
    expect([200, 500]).toContain(res.status);
  });
});
