import { afterEach, describe, expect, it, vi } from "vitest";
import { builderModel, builderStatus } from "../agent/lib/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("skill-builder configuration", () => {
  it("reports a truthful disabled status without server credentials", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PSKILLS_BUILDER_AI_ENABLED", "true");
    const status = builderStatus();
    expect(status.enabled).toBe(false);
    expect(status.reasonCodes).toContain("GATEWAY_CREDENTIAL_MISSING");
    expect(status.reasonCodes).toContain("REGISTRY_URL_MISSING");
    expect(status.reasonCodes).toContain("REGISTRY_TOKEN_MISSING");
    expect(status.reasonCodes).toContain("EVE_TOKEN_MISSING");
    expect(status).not.toHaveProperty("token");
  });

  it("requires every separate credential before reporting enabled", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PSKILLS_BUILDER_AI_ENABLED", "true");
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-token");
    vi.stubEnv("PSKILLS_BUILDER_REGISTRY_API_URL", "https://registry.example.test");
    vi.stubEnv("PSKILLS_BUILDER_REGISTRY_TOKEN", "registry-token");
    vi.stubEnv("PSKILLS_BUILDER_SERVICE_TOKEN", "service-token");
    vi.stubEnv("PSKILLS_BUILDER_EVE_API_TOKEN", "eve-token");
    const status = builderStatus();
    expect(status.enabled).toBe(true);
    expect(status.model).toBe("openai/gpt-5.5");
    expect(status.gatewayConfigured).toBe(true);
    expect(status.registryConfigured).toBe(true);
    expect(status.serviceConfigured).toBe(true);
    expect(status.eveConfigured).toBe(true);
  });

  it("accepts a bounded production-sized Vercel OIDC JWT", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PSKILLS_BUILDER_AI_ENABLED", "true");
    vi.stubEnv("VERCEL_OIDC_TOKEN", `header.${"x".repeat(700)}.signature`);
    vi.stubEnv("PSKILLS_BUILDER_REGISTRY_API_URL", "https://registry.example.test");
    vi.stubEnv("PSKILLS_BUILDER_REGISTRY_TOKEN", "registry-token");
    vi.stubEnv("PSKILLS_BUILDER_SERVICE_TOKEN", "service-token");
    vi.stubEnv("PSKILLS_BUILDER_EVE_API_TOKEN", "eve-token");
    const status = builderStatus();
    expect(status.enabled).toBe(true);
    expect(status.gatewayConfigured).toBe(true);
  });

  it("accepts the hosted Vercel OIDC request-context credential", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PSKILLS_BUILDER_AI_ENABLED", "true");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    vi.stubEnv("PSKILLS_BUILDER_REGISTRY_API_URL", "https://registry.example.test");
    vi.stubEnv("PSKILLS_BUILDER_REGISTRY_TOKEN", "registry-token");
    vi.stubEnv("PSKILLS_BUILDER_SERVICE_TOKEN", "service-token");
    vi.stubEnv("PSKILLS_BUILDER_EVE_API_TOKEN", "eve-token");

    const symbol = Symbol.for("@vercel/request-context");
    const previous = Object.getOwnPropertyDescriptor(globalThis, symbol);
    const oidcToken = `header.${"x".repeat(700)}.signature`;
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      value: {
        get: () => ({ headers: { "x-vercel-oidc-token": oidcToken } }),
      },
    });
    try {
      const status = builderStatus();
      expect(status.enabled).toBe(true);
      expect(status.gatewayConfigured).toBe(true);
    } finally {
      if (previous) Object.defineProperty(globalThis, symbol, previous);
      else Reflect.deleteProperty(globalThis, symbol);
    }
  });

  it("rejects malformed model identifiers", () => {
    vi.stubEnv("PSKILLS_BUILDER_MODEL", "openai/no spaces");
    expect(() => builderModel()).toThrow(/provider\/model/u);
  });
});
