import { expect, it } from "vitest";
import { assertRequestOrigin, trustedRequestOrigins } from "@/lib/request-origin";
const config = { BETTER_AUTH_URL: "https://speak.example.test/", APP_DOMAIN: "speak.example.test" };
const request = (headers: Record<string, string> = {}, method = "POST") => new Request("http://untrusted-proxy-internal:3000/api/sessions", { method, headers });
it("allows all unsafe methods only from the explicit configured origin", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(() => assertRequestOrigin(request({ Origin: "https://speak.example.test" }, method), config, "")).not.toThrow();
});
it("permits a trusted referer only when Origin is absent", () => {
  expect(() => assertRequestOrigin(request({ Referer: "https://speak.example.test/practice?part=1" }), config, "")).not.toThrow();
  for (const Origin of ["null", "https://other.example.test", "https://speak.example.test/a"]) expect(() => assertRequestOrigin(request({ Origin, Referer: "https://speak.example.test/" }), config, "")).toThrow(expect.objectContaining({ status: 403, code: "untrusted_origin" }));
});
it("rejects missing origin and referer despite same-origin Fetch Metadata", () => {
  for (const headers of [{}, { "Sec-Fetch-Site": "same-origin" }, { Referer: "not a url" }] as Record<string, string>[]) expect(() => assertRequestOrigin(request(headers), config, "")).toThrow(expect.objectContaining({ code: "untrusted_origin" }));
});
it("does not trust sibling domains, prefixes, ports, schemes or forged proxy headers", () => {
  for (const Origin of ["https://speak.example.test.attacker.test", "https://other.example.test", "https://speak.example.test:8443", "http://speak.example.test", "https://speak.example.test@attacker.test"])
    expect(() => assertRequestOrigin(request({ Origin, Host: "speak.example.test", "X-Forwarded-Host": "speak.example.test", "X-Forwarded-Proto": "https", "Sec-Fetch-Site": "same-origin" }), config, "")).toThrow(expect.objectContaining({ code: "untrusted_origin" }));
});
it("ignores malformed and wildcard configuration while accepting explicit additional origins", () => {
  const additional = "https://secondary.example.test/, https://*.example.test, https://user:pass@example.test, invalid";
  expect([...trustedRequestOrigins(config, additional)]).toEqual(["https://speak.example.test", "https://secondary.example.test"]);
  expect(() => assertRequestOrigin(request({ Origin: "https://secondary.example.test" }), config, additional)).not.toThrow();
});
it("allows read-only methods without reading or requiring origin headers", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) expect(() => assertRequestOrigin(request({}, method), config, "")).not.toThrow();
});
it("keeps explicit loopback development origins and configured public origins separate", () => {
  const local = { BETTER_AUTH_URL: "http://127.0.0.1:3100", APP_DOMAIN: "localhost" };
  expect([...trustedRequestOrigins(local, "")]).toEqual(["http://127.0.0.1:3100"]);
  expect(() => assertRequestOrigin(request({ Origin: "http://127.0.0.1:3100" }), local, "")).not.toThrow();
  expect(() => assertRequestOrigin(request({ Origin: "http://localhost:3100" }), local, "")).toThrow(expect.objectContaining({ code: "untrusted_origin" }));
});
