import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createGithubAppJwt, GITHUB_API_URL, GithubAppAuth } from "../src/github_auth.ts";

const { privateKey: pem, publicKey: publicPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_ID = "Iv1.0123456789abcdef";
const INSTALLATION_ID = "456";
const NOW_MS = Date.parse("2016-07-11T21:14:10Z");
const EXPIRES_AT = "2016-07-11T22:14:10Z";

const TOKEN_FIXTURE = {
  token: "ghs_16C7e42F292c6912E7710c838347Ae178B4a",
  expires_at: EXPIRES_AT,
  permissions: { issues: "write", contents: "read" },
  repository_selection: "all",
};

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signed: string } {
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  expect(headerPart && payloadPart && signaturePart).toBeTruthy();
  return {
    header: JSON.parse(Buffer.from(headerPart, "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payloadPart, "base64url").toString()) as Record<string, unknown>,
    signed: `${headerPart}.${payloadPart}`,
  };
}

function expectValidJwt(
  jwt: string,
  nowMs = NOW_MS
): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const nowSec = Math.floor(nowMs / 1000);
  const decoded = decodeJwt(jwt);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  expect(decoded.header).toEqual({ alg: "RS256", typ: "JWT" });
  expect(decoded.payload.iss).toBe(APP_ID);
  expect(decoded.payload.iat).toBe(nowSec - 60);
  expect(decoded.payload.exp).toBe(nowSec + 10 * 60);
  expect(decoded.payload.exp).toBeLessThanOrEqual(nowSec + 10 * 60);
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey(publicPem),
      Buffer.from(signaturePart, "base64url")
    )
  ).toBe(true);
  return decoded;
}

function fixtureResponse(overrides: Record<string, unknown> = {}, status = 201): Response {
  return new Response(JSON.stringify({ ...TOKEN_FIXTURE, ...overrides }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub App JWT", () => {
  test("RS256 claims use client ID, iat 60s in the past, and exp at most 10 minutes", () => {
    const jwt = createGithubAppJwt({ appId: APP_ID, privateKey: pem, now: () => NOW_MS });
    expectValidJwt(jwt);
  });

  test("missing or invalid PEM fails closed and does not read env", () => {
    const previous = process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY = pem;
    try {
      expect(() => createGithubAppJwt({ appId: APP_ID, privateKey: "", now: () => NOW_MS })).toThrow(
        "Missing GitHub App private key"
      );
      expect(() => createGithubAppJwt({ appId: APP_ID, privateKey: "not-a-key", now: () => NOW_MS })).toThrow(
        "Invalid GitHub App private key"
      );
      expect(() => createGithubAppJwt({ appId: "", privateKey: pem, now: () => NOW_MS })).toThrow(
        "Missing GitHub App client ID"
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
      else process.env.GITHUB_APP_PRIVATE_KEY = previous;
    }
  });
});

describe("GitHub App installation token cache", () => {
  test("POSTs access_tokens with Bearer JWT and caches until expiry", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    let nowMs = NOW_MS;
    const auth = new GithubAppAuth({
      appId: APP_ID,
      privateKey: pem,
      installationId: INSTALLATION_ID,
      now: () => nowMs,
      fetchImpl: async (url, init) => {
        requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
        return fixtureResponse();
      },
    });

    expect(await auth.getInstallationToken()).toBe(TOKEN_FIXTURE.token);
    nowMs = Date.parse("2016-07-11T22:14:10Z") - 1;
    expect(await auth.getInstallationToken()).toBe(TOKEN_FIXTURE.token);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${GITHUB_API_URL}/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("Accept")).toBe("application/vnd.github+json");
    const authorization = requests[0]?.headers.get("Authorization") ?? "";
    expect(authorization.startsWith("Bearer ")).toBe(true);
    expectValidJwt(authorization.slice("Bearer ".length));
  });

  test("refresh helper mints a new token before expiry for long jobs", async () => {
    const tokens = ["ghs_cached", "ghs_refreshed"];
    const requests: string[] = [];
    const auth = new GithubAppAuth({
      appId: APP_ID,
      privateKey: pem,
      installationId: INSTALLATION_ID,
      now: () => NOW_MS,
      fetchImpl: async (url) => {
        requests.push(url);
        return fixtureResponse({ token: tokens[requests.length - 1] });
      },
    });

    expect(await auth.getInstallationToken()).toBe("ghs_cached");
    expect(await auth.refreshInstallationToken()).toBe("ghs_refreshed");
    expect(await auth.getInstallationToken()).toBe("ghs_refreshed");
    expect(requests).toHaveLength(2);
  });

  test("getInstallationToken refreshes after expiry", async () => {
    let nowMs = NOW_MS;
    const tokens = ["ghs_first", "ghs_second"];
    let n = 0;
    const auth = new GithubAppAuth({
      appId: APP_ID,
      privateKey: pem,
      installationId: INSTALLATION_ID,
      now: () => nowMs,
      fetchImpl: async () => fixtureResponse({ token: tokens[n++] }),
    });

    expect(await auth.getInstallationToken()).toBe("ghs_first");
    nowMs = Date.parse(EXPIRES_AT);
    expect(await auth.getInstallationToken()).toBe("ghs_second");
    expect(n).toBe(2);
  });

  test("non-JSON token response and HTTP errors fail closed", async () => {
    const cases: Response[] = [
      new Response("ok", { status: 201, headers: { "Content-Type": "text/plain" } }),
      new Response("<html>nope</html>", { status: 201 }),
      new Response("", { status: 201 }),
      fixtureResponse({ token: 1 }),
      fixtureResponse({ token: "" }),
      fixtureResponse({ expires_at: "not-a-date" }),
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 201 }),
      new Response(JSON.stringify({ message: "Requires authentication" }), { status: 401 }),
    ];

    for (const response of cases) {
      const auth = new GithubAppAuth({
        appId: APP_ID,
        privateKey: pem,
        installationId: INSTALLATION_ID,
        now: () => NOW_MS,
        fetchImpl: async () => response.clone(),
      });
      const err = await auth.getInstallationToken().then(
        () => undefined,
        (caught: unknown) => caught
      );
      expect(err).toBeInstanceOf(Error);
    }

    expect(
      () =>
        new GithubAppAuth({
          appId: APP_ID,
          privateKey: "",
          installationId: INSTALLATION_ID,
        })
    ).toThrow("Missing GitHub App private key");
  });
});
