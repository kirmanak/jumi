import { describe, expect, test } from "bun:test";
import {
  isReviewWebhookAction,
  parsePullRequestPayload,
  peekWebhookAction,
  validateWebhookPayload,
  verifyGiteaSignature,
} from "../src/webhook.ts";
import { encodeJson, makePayload, makeRepo, makeUser, signBody } from "./fixtures.ts";

describe("verifyGiteaSignature", () => {
  test("accepts valid signatures with or without sha256 prefix", async () => {
    const body = new TextEncoder().encode("payload");
    const signature = await signBody(body, "secret");

    expect(await verifyGiteaSignature(body, "secret", signature)).toBe(true);
    expect(await verifyGiteaSignature(body, "secret", `sha256=${signature}`)).toBe(true);
  });

  test("rejects missing and invalid signatures", async () => {
    const body = new TextEncoder().encode("payload");

    expect(await verifyGiteaSignature(body, "secret", null)).toBe(false);
    expect(await verifyGiteaSignature(body, "secret", "bad-signature")).toBe(false);
  });
});

describe("parsePullRequestPayload", () => {
  test("parses a valid pull request payload", () => {
    const payload = makePayload();
    expect(parsePullRequestPayload(encodeJson(payload)).repository.full_name).toBe("kirmanak/demo");
  });

  test("rejects malformed payloads", () => {
    expect(() => parsePullRequestPayload(encodeJson({ action: "opened" }))).toThrow("missing repository");
    expect(() => parsePullRequestPayload(new TextEncoder().encode("not-json"))).toThrow();
  });
});

describe("validateWebhookPayload", () => {
  const policy = {
    giteaUrl: "https://gitea.kirmanak.stream",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [],
  };

  test("creates a review job for opened, reopened, and new-commit PR events", () => {
    for (const action of ["opened", "reopened", "synchronized", "synchronize"]) {
      const result = validateWebhookPayload(makePayload({ action }), policy);

      expect("skip" in result).toBe(false);
      if (!("skip" in result)) {
        expect(result.owner).toBe("kirmanak");
        expect(result.repo).toBe("demo");
        expect(result.prNumber).toBe(7);
        expect(result.headSha).toBe("headsha");
        expect(result.prUpdatedAt).toBe("2026-05-23T00:00:00Z");
        expect(result.action).toBe(action);
      }
    }
  });

  test("skips description edits and unsupported actions", () => {
    expect(validateWebhookPayload(makePayload({ action: "edited" }), policy)).toEqual({
      skip: "unsupported action edited",
    });
    expect(validateWebhookPayload(makePayload({ action: "closed" }), policy)).toEqual({
      skip: "unsupported action closed",
    });
  });

  test("rejects disallowed orgs, repos, and origins", () => {
    expect(() =>
      validateWebhookPayload(makePayload({ repository: makeRepo({ full_name: "evil/demo" }) }), policy)
    ).toThrow("not allowed");

    expect(() => validateWebhookPayload(makePayload(), { ...policy, allowedRepos: ["kirmanak/other"] })).toThrow(
      "is not allowed"
    );

    expect(() =>
      validateWebhookPayload(
        makePayload({
          repository: makeRepo({
            html_url: "https://evil.test/kirmanak/demo",
            clone_url: "https://evil.test/kirmanak/demo.git",
          }),
        }),
        policy
      )
    ).toThrow("does not match configured Gitea origin");
  });

  test("allows any owner when allowedOrgs includes *", () => {
    const result = validateWebhookPayload(
      makePayload({
        repository: makeRepo({
          owner: makeUser({ login: "pulpy" }),
          name: "app",
          full_name: "pulpy/app",
        }),
      }),
      { ...policy, allowedOrgs: ["*"] }
    );

    expect("skip" in result).toBe(false);
    if (!("skip" in result)) {
      expect(result.owner).toBe("pulpy");
      expect(result.repo).toBe("app");
    }
  });

  test("wildcard mixed with named orgs still allows unlisted owners", () => {
    const result = validateWebhookPayload(
      makePayload({
        repository: makeRepo({
          owner: makeUser({ login: "AnnEternity" }),
          name: "notes",
          full_name: "AnnEternity/notes",
        }),
      }),
      { ...policy, allowedOrgs: ["*", "kirmanak", "personal"] }
    );

    expect("skip" in result).toBe(false);
    if (!("skip" in result)) {
      expect(result.owner).toBe("AnnEternity");
    }
  });

  test("wildcard still enforces repo allowlist when set", () => {
    expect(() =>
      validateWebhookPayload(
        makePayload({
          repository: makeRepo({
            owner: makeUser({ login: "pulpy" }),
            name: "app",
            full_name: "pulpy/app",
          }),
        }),
        { ...policy, allowedOrgs: ["*"], allowedRepos: ["kirmanak/demo"] }
      )
    ).toThrow("Repository pulpy/app is not allowed");
  });
});

describe("peekWebhookAction / isReviewWebhookAction", () => {
  test("reads action from a JSON body", () => {
    expect(peekWebhookAction(encodeJson({ action: "synchronize" }))).toBe("synchronize");
    expect(peekWebhookAction(encodeJson({}))).toBeUndefined();
    expect(peekWebhookAction(new TextEncoder().encode("not-json"))).toBeUndefined();
  });

  test("recognizes review actions", () => {
    expect(isReviewWebhookAction("opened")).toBe(true);
    expect(isReviewWebhookAction("assigned")).toBe(false);
    expect(isReviewWebhookAction(undefined)).toBe(false);
  });
});
