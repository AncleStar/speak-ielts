import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { assertRequestOrigin } from "@/lib/request-origin";

// An isolated compatibility experiment. The production auth configuration is not imported or changed.
const base = "https://ios-auth.example.test";
let auth: ReturnType<typeof createExperiment>;
let database: MemoryDB;

function createExperiment(store: MemoryDB) {
  return betterAuth({
    baseURL: base,
    secret: randomBytes(48).toString("hex"),
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: false },
    plugins: [bearer({ requireSignature: true })],
    logger: { disabled: true },
  });
}

beforeEach(() => {
  database = { user: [], session: [], account: [], verification: [] };
  auth = createExperiment(database);
});

async function register(email = "tester@example.test") {
  const response = await auth.handler(new Request(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email, name: "Synthetic tester", password: "TestOnlyPassword27" }),
  }));
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  expect(Boolean(token)).toBe(true);
  return token!;
}

async function session(token?: string) {
  const response = await auth.handler(new Request(`${base}/api/auth/get-session`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  }));
  expect(response.status).toBe(200);
  return await response.json() as { user?: { email: string }; session?: { expiresAt: string } } | null;
}

describe("Better Auth 1.7.5 isolated native bearer compatibility", () => {
  it("reads a signed session without browser cookies or an Origin header", async () => {
    const token = await register();
    expect((await session(token))?.user?.email).toBe("tester@example.test");
  });

  it("rejects absent, malformed and unsigned credentials", async () => {
    const token = await register();
    expect(await session()).toBeNull();
    expect(await session("not-a-session")).toBeNull();
    expect(await session(decodeURIComponent(token).split(".")[0])).toBeNull();
    expect(await session(`${token.slice(0, -1)}X`)).toBeNull();
  });

  it("keeps independent account sessions distinct", async () => {
    const first = await register("first@example.test");
    const second = await register("second@example.test");
    expect((await session(first))?.user?.email).toBe("first@example.test");
    expect((await session(second))?.user?.email).toBe("second@example.test");
  });

  it("does not accept an expired or revoked server session", async () => {
    const token = await register();
    database.session[0].expiresAt = new Date(0);
    expect(await session(token)).toBeNull();
    const fresh = await register("fresh@example.test");
    database.session.splice(0);
    expect(await session(fresh)).toBeNull();
  });

  it("does not bypass the existing production browser write-origin guard", async () => {
    const token = await register();
    const config = { BETTER_AUTH_URL: base, APP_DOMAIN: "ios-auth.example.test" };
    const request = new Request(`${base}/api/sessions`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(() => assertRequestOrigin(request, config, "")).toThrow(expect.objectContaining({ code: "untrusted_origin" }));
  });
});
