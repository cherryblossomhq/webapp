export type PlanTier = "free" | "pro" | "enterprise";

export interface MeResponse {
  user: {
    id: string;
    email: string | null;
    name: string | null;
  };
  plan: {
    tier: PlanTier;
    name: string;
    managedAi: boolean;
    allowedModels: string[];
  };
  limits: {
    maxTokensPerRequest: number;
    requestsPerMinute: number;
    requestsPerDay: number;
    monthlyTokens: number;
  };
  usage: {
    requestsThisMinute: number;
    minuteResetsAt: number | null;
    requestsThisDay: number;
    dayResetsAt: number | null;
    monthlyTokens: number;
    monthResetsAt: number | null;
  };
}

interface ApiErrorResponse {
  error: {
    type: string;
    message: string;
  };
}

export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AccountApiError";
  }
}

export function managedAccountUrl(configured?: string): string {
  const base = configured ?? "https://www.trycherryblossom.com";
  return new URL("/api/v1/me", base).toString();
}

export const MANAGED_ACCOUNT_URL = managedAccountUrl(
  import.meta.env.VITE_MANAGED_AI_URL,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isPlanTier(value: unknown): value is PlanTier {
  return value === "free" || value === "pro" || value === "enterprise";
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.type === "string" &&
    typeof value.error.message === "string"
  );
}

function isMeResponse(value: unknown): value is MeResponse {
  if (!isRecord(value)) return false;
  const { user, plan, limits, usage } = value;
  return (
    isRecord(user) &&
    typeof user.id === "string" &&
    isNullableString(user.email) &&
    isNullableString(user.name) &&
    isRecord(plan) &&
    isPlanTier(plan.tier) &&
    typeof plan.name === "string" &&
    typeof plan.managedAi === "boolean" &&
    Array.isArray(plan.allowedModels) &&
    plan.allowedModels.every((model) => typeof model === "string") &&
    isRecord(limits) &&
    isFiniteNumber(limits.maxTokensPerRequest) &&
    isFiniteNumber(limits.requestsPerMinute) &&
    isFiniteNumber(limits.requestsPerDay) &&
    isFiniteNumber(limits.monthlyTokens) &&
    isRecord(usage) &&
    isFiniteNumber(usage.requestsThisMinute) &&
    isNullableNumber(usage.minuteResetsAt) &&
    isFiniteNumber(usage.requestsThisDay) &&
    isNullableNumber(usage.dayResetsAt) &&
    isFiniteNumber(usage.monthlyTokens) &&
    isNullableNumber(usage.monthResetsAt)
  );
}

export async function fetchMe(
  accessToken: string,
  signal?: AbortSignal,
): Promise<MeResponse> {
  let response: Response;
  try {
    response = await fetch(MANAGED_ACCOUNT_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      cache: "no-store",
      signal,
    });
  } catch (error) {
    throw new AccountApiError(0, "network_error", "Account request failed.", {
      cause: error,
    });
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The typed fallback below is more useful than leaking a JSON parser error.
  }

  if (!response.ok) {
    if (isApiErrorResponse(body)) {
      throw new AccountApiError(
        response.status,
        body.error.type,
        body.error.message,
      );
    }
    throw new AccountApiError(
      response.status,
      "upstream_error",
      `Account request failed (${response.status}).`,
    );
  }

  if (!isMeResponse(body)) {
    throw new AccountApiError(
      response.status,
      "invalid_response",
      "Account response was incompatible with this app.",
    );
  }
  return body;
}
