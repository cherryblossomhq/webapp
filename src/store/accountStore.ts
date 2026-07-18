import { create } from "zustand";
import {
  AccountApiError,
  fetchMe,
  type MeResponse,
} from "@/utils/accountApi";
import { useAuthStore } from "./authStore";

export const DEFAULT_MANAGED_MODEL = "anthropic/claude-opus-4.8";
export const MANAGED_MODEL_STORAGE_KEY = "cherryblossom:managed-model";

export type AccountStatus = "idle" | "loading" | "ready" | "error";

interface AccountState {
  account: MeResponse | null;
  /** WorkOS user ID whose response is stored in `account`. */
  accountUserId: string | null;
  status: AccountStatus;
  error: string | null;
  selectedModel: string | null;
  /** Load only when there is no successful snapshot for the current user. */
  load: () => Promise<void>;
  /** Refresh even when a successful snapshot is already available. */
  refresh: () => Promise<void>;
  setSelectedModel: (model: string) => void;
  /** Clear memory-only account data while retaining the model preference. */
  clear: () => void;
}

let requestEpoch = 0;
let activeRequest: { userId: string; promise: Promise<void> } | null = null;

function readStoredModel(): string | null {
  try {
    return localStorage.getItem(MANAGED_MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistModel(model: string | null): void {
  try {
    if (model) localStorage.setItem(MANAGED_MODEL_STORAGE_KEY, model);
    else localStorage.removeItem(MANAGED_MODEL_STORAGE_KEY);
  } catch {
    // Selection remains usable in memory when storage is unavailable.
  }
}

export function reconcileManagedModel(
  models: string[],
  selected: string | null,
): string | null {
  if (selected && models.includes(selected)) return selected;
  if (models.includes(DEFAULT_MANAGED_MODEL)) return DEFAULT_MANAGED_MODEL;
  return models[0] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TerminalAccountAuthError extends Error {
  constructor(readonly accountError: AccountApiError) {
    super(accountError.message, { cause: accountError });
    this.name = "TerminalAccountAuthError";
  }
}

async function fetchAccountWithAuthRetry(
  initialToken: string,
): Promise<MeResponse> {
  try {
    return await fetchMe(initialToken);
  } catch (error) {
    if (!(error instanceof AccountApiError) || error.status !== 401) throw error;

    await useAuthStore.getState().refresh();
    const refreshedAuth = useAuthStore.getState();
    if (refreshedAuth.status !== "signedIn" || !refreshedAuth.accessToken) {
      throw error;
    }

    try {
      return await fetchMe(refreshedAuth.accessToken);
    } catch (retryError) {
      if (retryError instanceof AccountApiError && retryError.status === 401) {
        await useAuthStore.getState().signOut();
        throw new TerminalAccountAuthError(retryError);
      }
      throw retryError;
    }
  }
}

function requestAccount(force: boolean): Promise<void> {
  const auth = useAuthStore.getState();
  if (auth.status !== "signedIn" || !auth.user || !auth.accessToken) {
    return Promise.reject(new Error("Sign in to load account details."));
  }

  const userId = auth.user.id;
  const current = useAccountStore.getState();
  if (!force && current.account && current.accountUserId === userId) {
    return Promise.resolve();
  }
  if (activeRequest?.userId === userId) return activeRequest.promise;

  const epoch = requestEpoch;
  useAccountStore.setState({ status: "loading", error: null });

  const promise = fetchAccountWithAuthRetry(auth.accessToken)
    .then((account) => {
      const latestAuth = useAuthStore.getState();
      if (
        epoch !== requestEpoch ||
        latestAuth.status !== "signedIn" ||
        latestAuth.user?.id !== userId
      ) {
        return;
      }
      if (account.user.id !== userId) {
        throw new AccountApiError(
          200,
          "invalid_response",
          "Account response did not match the signed-in user.",
        );
      }

      const allowedModels = account.plan.managedAi
        ? account.plan.allowedModels
        : [];
      const selectedModel = reconcileManagedModel(
        allowedModels,
        useAccountStore.getState().selectedModel,
      );
      persistModel(selectedModel);
      useAccountStore.setState({
        account,
        accountUserId: userId,
        status: "ready",
        error: null,
        selectedModel,
      });
    })
    .catch((error: unknown) => {
      const latestAuth = useAuthStore.getState();
      if (
        epoch !== requestEpoch ||
        (!(error instanceof TerminalAccountAuthError) &&
          (latestAuth.status !== "signedIn" || latestAuth.user?.id !== userId))
      ) {
        return;
      }
      useAccountStore.setState({
        status: "error",
        error: errorMessage(error),
      });
      throw error;
    })
    .finally(() => {
      if (activeRequest?.promise === promise) activeRequest = null;
    });

  activeRequest = { userId, promise };
  return promise;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  account: null,
  accountUserId: null,
  status: "idle",
  error: null,
  selectedModel: readStoredModel(),

  load: () => requestAccount(false),
  refresh: () => requestAccount(true),

  setSelectedModel: (model) => {
    const account = get().account;
    if (
      !account?.plan.managedAi ||
      !account.plan.allowedModels.includes(model)
    ) {
      return;
    }
    persistModel(model);
    set({ selectedModel: model });
  },

  clear: () => {
    requestEpoch++;
    activeRequest = null;
    set({
      account: null,
      accountUserId: null,
      status: "idle",
      error: null,
    });
  },
}));
