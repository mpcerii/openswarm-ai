import { describe, expect, test } from "bun:test"
import { SwarmCredentials } from "../src/cluster/credentials"

const credential: SwarmCredentials.Record = {
  id: "swcr_1",
  worker_id: "swk_1",
  name: "w1",
  secret_hash: "",
  scopes: { capabilities: ["review"], providers: ["anthropic"], models: ["anthropic/claude-sonnet-4"], platforms: ["linux"] },
  revoked: 0,
  created_at: 0,
  expires_at: null,
}

describe("worker credentials", () => {
  test("sha256 hashes are deterministic and never return the raw secret", () => {
    const secret = "swsec_abc123"
    const hash = SwarmCredentials.makeSecret(secret)
    expect(hash).toBe(SwarmCredentials.makeSecret(secret))
    expect(hash).not.toContain(secret)
    expect(hash.length).toBe(64)
    expect(SwarmCredentials.verifySecret(secret, hash)).toBe(true)
    expect(SwarmCredentials.verifySecret("swsec_wrong", hash)).toBe(false)
  })

  test("revoked or expired credentials are unusable", () => {
    expect(SwarmCredentials.isUsable(credential, 100)).toBe(true)
    expect(SwarmCredentials.isUsable({ ...credential, revoked: 1 }, 100)).toBe(false)
    expect(SwarmCredentials.isUsable({ ...credential, expires_at: 50 }, 100)).toBe(false)
  })

  test("provider scope is fail-closed: empty providers denies everything", () => {
    const noProviders = { ...credential, scopes: { ...credential.scopes, providers: [] } }
    expect(SwarmCredentials.allowsProvider(noProviders, "anthropic")).toBe(false)
    expect(SwarmCredentials.allowsSecretScope(noProviders, "provider:anthropic")).toBe(false)
    expect(SwarmCredentials.allowsProvider(credential, "anthropic")).toBe(true)
    expect(SwarmCredentials.allowsProvider(credential, "openai")).toBe(false)
    expect(SwarmCredentials.allowsSecretScope(credential, "provider:anthropic")).toBe(true)
    expect(SwarmCredentials.allowsSecretScope(credential, "provider:openai")).toBe(false)
    // Non-provider scopes (e.g. repo-scoped) are not gated by provider lists.
    expect(SwarmCredentials.allowsSecretScope(noProviders, "repo:acme/backend")).toBe(true)
  })
})
