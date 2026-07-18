import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountApiError,
  fetchMe,
  managedAccountUrl,
  type MeResponse,
} from "./accountApi";

const meResponse: MeResponse = {
  user: {
    id: "user_123",
    email: "engineer@example.com",
    name: "Example Engineer",
  },
  plan: {
    tier: "pro",
    name: "Pro",
    managedAi: true,
    allowedModels: [
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.8",
    ],
  },
  limits: {
    maxTokensPerRequest: 64_000,
    requestsPerMinute: 10,
    requestsPerDay: 200,
    monthlyTokens: 2_000_000,
  },
  usage: {
    requestsThisMinute: 2,
    minuteResetsAt: 1_784_390_460_000,
    requestsThisDay: 14,
    dayResetsAt: null,
    monthlyTokens: 124_500,
    monthResetsAt: 1_786_982_400_000,
  },
  unlimitedCredits: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managedAccountUrl", () => {
  it("forces the account path for both origins and legacy endpoint URLs", () => {
    expect(managedAccountUrl("https://example.test")).toBe(
      "https://example.test/api/v1/me",
    );
    expect(
      managedAccountUrl("https://example.test/api/v1/chat/completions"),
    ).toBe("https://example.test/api/v1/me");
  });
});

describe("fetchMe", () => {
  it("sends a bearer-authenticated uncached request and returns the account", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(meResponse));

    await expect(fetchMe("workos-token")).resolves.toEqual(meResponse);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.trycherryblossom.com/api/v1/me",
      {
        method: "GET",
        headers: {
          authorization: "Bearer workos-token",
          accept: "application/json",
        },
        cache: "no-store",
        signal: undefined,
      },
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).not.toHaveProperty("credentials");
  });

  it("surfaces the documented error envelope as a typed error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: {
            type: "not_authenticated",
            message: "Invalid or expired access token.",
          },
        },
        { status: 401 },
      ),
    );

    await expect(fetchMe("expired")).rejects.toEqual(
      expect.objectContaining({
        name: "AccountApiError",
        status: 401,
        type: "not_authenticated",
        message: "Invalid or expired access token.",
      }),
    );
  });

  it("uses a stable typed error for a non-JSON failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad gateway", { status: 502 }),
    );

    await expect(fetchMe("token")).rejects.toEqual(
      expect.objectContaining({
        name: "AccountApiError",
        status: 502,
        type: "upstream_error",
        message: "Account request failed (502).",
      }),
    );
  });

  it("rejects a successful response whose required fields are incompatible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...meResponse,
        plan: { ...meResponse.plan, allowedModels: [42] },
      }),
    );

    await expect(fetchMe("token")).rejects.toEqual(
      expect.objectContaining({
        name: "AccountApiError",
        status: 200,
        type: "invalid_response",
      }),
    );
  });

  it("exposes AccountApiError as an Error subtype", () => {
    expect(new AccountApiError(502, "upstream_error", "Unavailable")).toBeInstanceOf(
      Error,
    );
  });
});
