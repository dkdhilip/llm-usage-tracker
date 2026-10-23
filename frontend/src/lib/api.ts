const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// CSRF: the server sets a readable `csrf_token` cookie next to the (HttpOnly)
// session cookie; every unsafe request must echo it back in X-CSRF-Token. Safe
// methods need nothing. See backend/app/csrf.py.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfToken(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Expired sessions. A 401 from the cookie-authenticated /api surface means the session is gone (it expired, or the
// account was removed elsewhere): the app is told so it can drop to signed-out and show the login page. It is NOT
// raised for /api/auth/login|signup (a 401 there only means "wrong username or password"), nor for the /v1
// virtual-key API the Playground calls through this same function (a 401 there is a bad or revoked virtual key, not
// a session). Other 403s (not an admin, no workspace, key paused) are real answers and never sign the user out.
let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(fn: (() => void) | null): void {
  sessionExpiredHandler = fn;
}

const AUTH_ENTRY_PATHS = new Set(["/api/auth/login", "/api/auth/signup"]);

function isSessionRequest(path: string): boolean {
  const p = path.split("?")[0];
  return p.startsWith("/api/") && !AUTH_ENTRY_PATHS.has(p);
}

// The server's CSRF rejection (backend/app/csrf.py): a 403 whose detail starts with "CSRF token".
function isCsrfRejection(status: number, detail: unknown): boolean {
  return status === 403 && typeof detail === "string" && detail.startsWith("CSRF token");
}

async function req<T>(path: string, init: RequestInit = {}, retriedAfterCsrf = false): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const token = SAFE_METHODS.has(method) ? null : csrfToken();
  const res = await fetch(BASE + path, {
    ...init,
    credentials: "include", // carry the session cookie
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-CSRF-Token": token } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      detail = (await res.json())?.detail ?? detail;
    } catch {
      /* body was not JSON */
    }
    if (isSessionRequest(path)) {
      if (res.status === 401) {
        sessionExpiredHandler?.();
      } else if (isCsrfRejection(res.status, detail) && !retriedAfterCsrf) {
        // The csrf_token cookie is missing or stale while the session may still be valid (a session older than the
        // CSRF rollout, a cleared cookie). GET /api/auth/me re-issues it. The server refused this request before
        // running it, so retrying once is safe. If /me says signed out, it is the session that expired.
        const me = await req<{ authenticated: boolean }>("/api/auth/me");
        if (me.authenticated) return req<T>(path, init, true);
        sessionExpiredHandler?.();
      }
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return (await res.json()) as T;
}

// ---- types ----
export const PROVIDERS = ["openai", "anthropic", "openrouter", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type WorkspaceRole = "admin" | "member";

export interface ModelInfo {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

export interface ProviderEnvStatus {
  provider: string;
  env_var: string;
  configured_via_env: boolean;
  breaker_open: boolean;
  breaker_failures: number;
}

export interface WorkspaceRef {
  id: number;
  name: string;
  role: WorkspaceRole;
}

export interface AuthUser {
  id: number;
  username: string;
  workspace: WorkspaceRef | null;
}

export interface Account {
  username: string;
  workspace: WorkspaceRef | null;
  live_cap_default_usd: number;
}

export interface WorkspaceProvider {
  provider: string;
  configured: boolean;
  source: "env" | "workspace" | "none";
  last4: string | null;
  monthly_cap_usd: number | null; // null => the default applies
  spend_this_month: number;
}

export interface WorkspaceMember {
  user_id: number;
  username: string;
  role: WorkspaceRole;
  assigned_keys: number;
  requests: number;
  cost: number;
}

export interface WorkspaceInvite {
  id: number;
  code: string;
  label: string | null;
  created_at?: string;
  expires_at: string;
}

export interface ContentLoggingState {
  enabled: boolean;
  retention_days: number;
  updated_at: string | null;
}

export interface ImageLoggingState {
  enabled: boolean;
  updated_at: string | null;
  // admins only
  used_bytes?: number;
  cap_bytes?: number;
  max_image_bytes?: number;
  max_per_request?: number;
  global_full?: boolean;
}

export interface WorkspaceDetail {
  id: number;
  name: string;
  role: WorkspaceRole;
  content_logging?: ContentLoggingState;
  image_logging?: ImageLoggingState;
  members?: WorkspaceMember[];
  invites?: WorkspaceInvite[];
  providers?: WorkspaceProvider[];
}

export type BudgetPeriod = "day" | "week" | "month" | "custom";

// "workspace" = this workspace's own model_pricing override (see ModelPricingRow)
export type CostSource = "provider" | "workspace" | "configured" | "unknown";

export interface ModelPricingRow {
  id: number;
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  created_at: string;
  updated_at: string;
}

export type IntegrationTarget = "hosted" | "local";
export type IntegrationProviderId = "openai" | "anthropic" | "gemini";

export interface IntegrationProvider {
  provider: IntegrationProviderId;
  label: string;
  sdk: string;
  intro?: string; // lead-in shown above the steps (OpenAI only)
  install: string;
  gateway_url: string;
  base_url: string;
  endpoint: string;
  env_vars: { name: string; value: string; comment: string }[];
  env_file: string;
  code: string;
  alt_title?: string; // a second, explicit-configuration snippet (OpenAI only)
  alt_code?: string;
  model_example: string;
  notes: string[];
  requirements: string[];
}

export interface IntegrationGuideData {
  target: IntegrationTarget;
  gateway_url: string;
  targets: Record<IntegrationTarget, string>;
  general_notes: string[];
  providers: IntegrationProvider[];
}

export interface KeyRow {
  id: number;
  label: string;
  key_prefix: string;
  assigned_username: string | null;
  allowed_providers: string[];
  allow_live: boolean;
  default_provider: string | null;
  monthly_budget_usd: number | null;
  budget_period: BudgetPeriod;
  budget_start: string | null;
  budget_end: string | null;
  expires_at: string | null; // null = never expires
  spend_period: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  requests: number;
  total_tokens: number;
  cost: number;
}

export interface KeyCreated {
  id: number;
  label: string;
  key: string;
  key_prefix: string;
  allowed_providers: string[];
  allow_live: boolean;
  default_provider: string | null;
  monthly_budget_usd: number | null;
  budget_period: BudgetPeriod;
  budget_start: string | null;
  budget_end: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface RequestRow {
  id: number;
  ts: string;
  request_id: string;
  key_id: number;
  key_label: string;
  key_prefix: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number | null;
  cost_source: CostSource;
  latency_ms: number;
  status: string;
  prompt_preview: string | null;
  response_preview: string | null;
  has_content?: boolean;
}

export type ContentStatus = "available" | "expired" | "not_captured" | "unreadable";

export interface StoredContent {
  v: number;
  kind: string;
  request: Record<string, unknown> & {
    messages?: { role: string; text: string }[];
    system?: string;
    input?: string | string[];
    prompt?: string;
  };
  response: { text: string; summary: string };
  images_skipped?: { role: "input" | "output"; reason: string }[];
}

export interface StoredImage {
  id: number;
  role: "input" | "output";
  position: number;
  mime: string;
  bytes: number;
}

export interface RequestContent {
  usage_id: number;
  retention_days: number;
  content_status: ContentStatus;
  content: StoredContent | null;
  images?: StoredImage[];
  kind?: string;
  created_at?: string;
  expires_at?: string;
  request_truncated?: boolean;
  response_truncated?: boolean;
}

export interface KeyInspect {
  label: string;
  allow_live: boolean;
  providers: { provider: string; ready: boolean }[]; // ready = a workspace key exists
}

export interface UsageSummary {
  total_requests: number;
  total_tokens: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost: number;
  cost_actual: number;
  cost_estimated: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  error_rate: number;
  errors: number;
  tokens_per_sec: number;
  active_keys: number;
}

export interface TimeseriesPoint {
  day: string;
  provider: string;
  requests: number;
  total_tokens: number;
  cost: number;
}

export interface ByKeyRow {
  key_id: number;
  label: string;
  key_prefix: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  last_used_at: string | null;
}

export interface ByModelRow {
  provider: string;
  model: string;
  requests: number;
  total_tokens: number;
  cost: number;
}

export interface ChatResult {
  request_id: string;
  provider: string;
  model: string;
  response: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost: number | null;
  cost_source: CostSource;
  pricing: { input_per_1m: number | null; output_per_1m: number | null; source: string };
  latency_ms: number;
}

export const api = {
  health: () => req<{ status: string; version: string }>("/healthz"),
  models: () => req<ModelInfo[]>("/api/models"),

  // ---- auth ----
  me: () => req<{ authenticated: boolean; user: AuthUser | null }>("/api/auth/me"),
  login: (username: string, password: string) =>
    req<{ authenticated: boolean; user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  signup: (username: string, password: string) =>
    req<{ authenticated: boolean; user: AuthUser }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),

  // ---- account (personal) ----
  getAccount: () => req<Account>("/api/account"),
  deleteAccount: () => req<{ deleted: boolean }>("/api/account", { method: "DELETE" }),

  // ---- workspace ----
  getWorkspace: () => req<WorkspaceDetail>("/api/workspace"),
  createWorkspace: (name: string) =>
    req<WorkspaceDetail>("/api/workspace", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renameWorkspace: (name: string) =>
    req<WorkspaceDetail>("/api/workspace", {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  setContentLogging: (enabled: boolean) =>
    req<WorkspaceDetail>("/api/workspace/content-logging", {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  deleteStoredContent: () => req<{ deleted: number }>("/api/workspace/content", { method: "DELETE" }),
  deleteWorkspace: () => req<{ deleted: boolean }>("/api/workspace", { method: "DELETE" }),
  leaveWorkspace: () => req<{ left: boolean }>("/api/workspace/leave", { method: "POST" }),
  joinWorkspace: (code: string) =>
    req<WorkspaceDetail>("/api/workspace/join", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  createInvite: (label?: string) =>
    req<WorkspaceInvite>("/api/workspace/invites", {
      method: "POST",
      body: JSON.stringify({ label: label?.trim() || null }),
    }),
  revokeInvite: (id: number) =>
    req<{ revoked: boolean }>(`/api/workspace/invites/${id}`, { method: "DELETE" }),
  removeMember: (userId: number) =>
    req<{ removed: boolean }>(`/api/workspace/members/${userId}`, { method: "DELETE" }),
  workspaceProviders: () => req<WorkspaceProvider[]>("/api/workspace/providers"),
  setWorkspaceProviderKey: (provider: string, apiKey: string) =>
    req<{ provider: string; last4: string; valid: boolean }>(
      `/api/workspace/providers/${provider}/key`,
      { method: "PUT", body: JSON.stringify({ api_key: apiKey }) },
    ),
  clearWorkspaceProviderKey: (provider: string) =>
    req<{ provider: string }>(`/api/workspace/providers/${provider}/key`, {
      method: "DELETE",
    }),
  setWorkspaceProviderCap: (provider: string, monthlyCapUsd: number | null) =>
    req<WorkspaceProvider[]>(`/api/workspace/providers/${provider}/cap`, {
      method: "PATCH",
      body: JSON.stringify({ monthly_cap_usd: monthlyCapUsd }),
    }),

  // ---- model pricing registry (workspace-owned price overrides) ----
  listModelPricing: () => req<ModelPricingRow[]>("/api/workspace/pricing"),
  upsertModelPricing: (input: {
    provider: string;
    model: string;
    input_per_1m: number;
    output_per_1m: number;
  }) =>
    req<ModelPricingRow>("/api/workspace/pricing", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteModelPricing: (id: number) =>
    req<{ deleted: boolean }>(`/api/workspace/pricing/${id}`, { method: "DELETE" }),

  // ---- providers (instance-wide env status; admin) ----
  providers: () => req<ProviderEnvStatus[]>("/api/providers"),

  // ---- developer-integration guide (copy-ready per-provider setup; never contains a key) ----
  integrationGuide: (target: IntegrationTarget) =>
    req<IntegrationGuideData>(`/api/integration?target=${target}`),

  usageSummary: (qs: string) => req<UsageSummary>(`/api/usage/summary${qs}`),
  usageTimeseries: (qs: string) => req<TimeseriesPoint[]>(`/api/usage/timeseries${qs}`),
  usageByKey: (qs: string) => req<ByKeyRow[]>(`/api/usage/by-key${qs}`),
  usageByModel: (qs: string) => req<ByModelRow[]>(`/api/usage/by-model${qs}`),

  listRequests: (qs: string) =>
    req<{
      items: RequestRow[];
      next_cursor: number | null;
      bodies_logged: boolean;
      content_logging_enabled?: boolean;
    }>(`/api/requests${qs}`),
  setImageLogging: (enabled: boolean) =>
    req<WorkspaceDetail>("/api/workspace/image-logging", {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  requestImageUrl: (usageId: number, imageId: number) =>
    `/api/requests/${usageId}/images/${imageId}`,
  requestContent: (id: number) => req<RequestContent>(`/api/requests/${id}/content`),

  listKeys: () => req<KeyRow[]>("/api/keys"),
  createKey: (input: {
    label: string;
    allowed_providers: string[];
    allow_live: boolean;
    default_provider?: string | null;
    assigned_user_id?: number | null;
    monthly_budget_usd?: number | null;
    budget_period?: BudgetPeriod;
    budget_start?: string | null;
    budget_end?: string | null;
  }) =>
    req<KeyCreated>("/api/keys", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateKey: (
    id: number,
    patch: {
      allow_live?: boolean;
      default_provider?: string | null;
      assigned_user_id?: number | null;
      clear_assignment?: boolean;
      monthly_budget_usd?: number | null;
      budget_period?: BudgetPeriod;
      budget_start?: string | null;
      budget_end?: string | null;
      clear_budget?: boolean;
    },
  ) =>
    req<Record<string, unknown>>(`/api/keys/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  revokeKey: (id: number) =>
    req<{ id: number; revoked_at: string }>(`/api/keys/${id}`, {
      method: "DELETE",
    }),

  inspectKey: (key: string) =>
    req<KeyInspect>("/v1/proxy/inspect", {
      headers: { Authorization: `Bearer ${key}` },
    }),
  proxyChat: (
    payload: { provider: string; model: string; prompt: string },
    key: string,
  ) =>
    req<ChatResult>("/v1/proxy/chat", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { Authorization: `Bearer ${key}` },
    }),
};
