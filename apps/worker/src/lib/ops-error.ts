import type { Context } from "hono";

/** Machine code plus a sentence the admin UI can render as-is. */
export type OpsErrorBody = { error: string; code: string };

const MESSAGES: Record<string, string> = {
  alert_channel: "Check the channel name, secret name, and choose at least one event.",
  auth: "Sign in to continue.",
  body: "Request body must be 64 KB or smaller.",
  cloudflare_api: "Cloudflare API rejected the request. Check your API token permissions.",
  component: "One of those components no longer exists.",
  confirm_fails: "Confirmation runs must be from 1 to 10.",
  credentials: "Email or password is incorrect.",
  decode: "That file could not be read as an image.",
  delivery: "The alert queue is not available in this environment.",
  end_at: "Pick an end time in the future, within 90 days.",
  exists: "That already exists.",
  expect: "Check the response assertions and expected status codes.",
  forbidden: "You do not have permission to do that.",
  headers: "Check the header names and keep values under 8 KB.",
  https_required: "Use HTTPS. Plain HTTP is only enabled for localhost in local development.",
  icon: "Could not save that icon.",
  incident_time: "Incident start must be within the past year and not in the future.",
  internal: "Something went wrong. Try again.",
  interval: "Interval must be from 30 seconds to 24 hours.",
  invalid: "That request was not valid.",
  invalid_cursor: "That page is no longer valid. Refresh and try again.",
  invalid_email: "Use a valid email address.",
  invalid_id: "That id is not valid.",
  invalid_password: "Password must be 12–128 characters.",
  invalid_role: "Role must be admin or superadmin.",
  invalid_url: "Use an http(s) address, without a username.",
  jsonpath_invalid: "JSON path is not valid.",
  last_superadmin: "You cannot remove the last superadmin.",
  latency: "Degrade-above must be at least 1ms and below the timeout. At or past timeout is a failure.",
  management_unavailable:
    "Secret management requires FOXWATCH_CF_API_TOKEN, FOXWATCH_CF_ACCOUNT_ID, and FOXWATCH_CF_SCRIPT_NAME in the Worker environment.",
  mute_until: "Mute must end within the next 90 days.",
  not_found: "That item is gone.",
  overlap: "This component already has scheduled maintenance.",
  private_address: "Private network targets are blocked to protect the Worker.",
  quota: "Monitor quota reached.",
  rate: "Too many attempts. Try again in a few minutes.",
  regions: "Choose from 1 to 8 supported regions.",
  retries: "Retries must be from 0 to 5.",
  rotate_only: "That secret is set on the Worker. Rotate it by sending a new value.",
  secret: "Use a name like API_TOKEN and a value up to 8 KB.",
  secret_required: "Sensitive headers must reference a Worker secret instead of storing a literal value.",
  secret_value: "A non-empty value is required (max 8 KB).",
  self: "You cannot remove your own account.",
  setup: "Create the first account to continue.",
  start_at: "Pick a start time within the next 90 days.",
  title: "Add a public incident title.",
  timeout: "Timeout must be from 1ms to 60 seconds.",
  too_large: "That image is still too large after resizing.",
  update_body: "Add a public incident update message.",
  userinfo_forbidden: "Put credentials in a secret-backed header, not in the URL.",
};

export function opsErrorBody(codeOrMessage: string, message?: string): OpsErrorBody {
  if (message) return { error: message, code: codeOrMessage };
  const mapped = MESSAGES[codeOrMessage];
  if (mapped) return { error: mapped, code: codeOrMessage };
  if (looksLikeMessage(codeOrMessage)) return { error: codeOrMessage, code: "invalid" };
  return { error: MESSAGES.internal ?? "Something went wrong. Try again.", code: codeOrMessage || "internal" };
}

export function fail(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
  code: string,
  message?: string,
) {
  return c.json(opsErrorBody(code, message), status);
}

export function failFromUnknown(c: Context, err: unknown, status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503 = 400) {
  const raw = err instanceof Error ? err.message : "invalid";
  if (MESSAGES[raw]) return fail(c, status, raw);
  if (looksLikeMessage(raw)) return fail(c, status, "invalid", raw);
  return fail(c, status, "invalid");
}

export function internalErrorResponse(headers?: HeadersInit): Response {
  return new Response(JSON.stringify(opsErrorBody("internal")), {
    status: 500,
    headers: { "content-type": "application/json", ...headers },
  });
}

function looksLikeMessage(value: string): boolean {
  return value.includes(" ") || value.length > 32;
}
