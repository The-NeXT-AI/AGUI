import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import path from "node:path";

export type RuntimeAuthMode = "disabled" | "token" | "webauth" | "oauth";

export type RuntimeAuthUser = {
  claims?: Record<string, unknown>;
  email?: string;
  id: string;
  name?: string;
};

export type RuntimeAuthContext = {
  mode: RuntimeAuthMode;
  tenantId: string;
  tenantKey: string;
  user: RuntimeAuthUser;
};

export type RuntimeAuthOptions = {
  allowedTenants?: string[];
  authorizationUrl?: string;
  callbackPath?: string;
  clientAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
  clientId?: string;
  clientSecret?: string;
  cookieName?: string;
  cookieSecure?: boolean;
  defaultTenantId?: string;
  issuer?: string;
  logoutRedirectPath?: string;
  mode?: RuntimeAuthMode;
  publicUrl?: string;
  scope?: string;
  sessionTtlMs?: number;
  tenantClaim?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  webAuthUsers?: RuntimeWebAuthUser[];
};

export type RuntimeWebAuthUser = {
  email?: string;
  name?: string;
  password?: string;
  passwordSha256?: string;
  tenantId?: string;
  username: string;
};

type OAuthDiscovery = {
  authorization_endpoint?: string;
  issuer?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
};

type OAuthState = {
  codeVerifier: string;
  createdAt: number;
  nonce: string;
  returnTo: string;
};

type RuntimeAuthSession = {
  context: RuntimeAuthContext;
  expiresAt: number;
};

const DEFAULT_COOKIE_NAME = "agui_session";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_SCOPE = "openid email profile";
const FORM_BODY_MAX_BYTES = 32 * 1024;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SAFE_SEGMENT_LIMIT = 96;

export function configuredRuntimeAuthOptions(
  env: NodeJS.ProcessEnv,
  defaults: { mode?: RuntimeAuthMode } = {},
): RuntimeAuthOptions {
  const mode = normalizeAuthMode(env.AG_UI_AUTH_MODE ?? env.AGUI_AUTH_MODE, defaults.mode);
  return {
    allowedTenants: list(
      env.AG_UI_AUTH_ALLOWED_TENANTS ??
        env.AGUI_AUTH_ALLOWED_TENANTS ??
        env.AG_UI_OAUTH_ALLOWED_TENANTS ??
        env.AGUI_OAUTH_ALLOWED_TENANTS,
    ),
    authorizationUrl: text(env.AG_UI_OAUTH_AUTHORIZATION_URL ?? env.AGUI_OAUTH_AUTHORIZATION_URL),
    callbackPath: text(env.AG_UI_OAUTH_CALLBACK_PATH ?? env.AGUI_OAUTH_CALLBACK_PATH),
    clientAuthMethod: normalizeClientAuthMethod(
      env.AG_UI_OAUTH_CLIENT_AUTH_METHOD ?? env.AGUI_OAUTH_CLIENT_AUTH_METHOD,
    ),
    clientId: text(env.AG_UI_OAUTH_CLIENT_ID ?? env.AGUI_OAUTH_CLIENT_ID),
    clientSecret: text(env.AG_UI_OAUTH_CLIENT_SECRET ?? env.AGUI_OAUTH_CLIENT_SECRET),
    cookieName: text(env.AG_UI_AUTH_COOKIE_NAME ?? env.AGUI_AUTH_COOKIE_NAME),
    cookieSecure: bool(env.AG_UI_AUTH_COOKIE_SECURE ?? env.AGUI_AUTH_COOKIE_SECURE),
    defaultTenantId: text(env.AG_UI_AUTH_DEFAULT_TENANT ?? env.AGUI_AUTH_DEFAULT_TENANT),
    issuer: text(env.AG_UI_OAUTH_ISSUER ?? env.AGUI_OAUTH_ISSUER),
    logoutRedirectPath: text(env.AG_UI_AUTH_LOGOUT_REDIRECT ?? env.AGUI_AUTH_LOGOUT_REDIRECT),
    mode,
    publicUrl: text(env.AG_UI_PUBLIC_URL ?? env.AGUI_PUBLIC_URL),
    scope: text(env.AG_UI_OAUTH_SCOPE ?? env.AGUI_OAUTH_SCOPE),
    sessionTtlMs: seconds(env.AG_UI_AUTH_SESSION_TTL_SECONDS ?? env.AGUI_AUTH_SESSION_TTL_SECONDS),
    tenantClaim: text(env.AG_UI_OAUTH_TENANT_CLAIM ?? env.AGUI_OAUTH_TENANT_CLAIM),
    tokenUrl: text(env.AG_UI_OAUTH_TOKEN_URL ?? env.AGUI_OAUTH_TOKEN_URL),
    userInfoUrl: text(env.AG_UI_OAUTH_USERINFO_URL ?? env.AGUI_OAUTH_USERINFO_URL),
    webAuthUsers: configuredWebAuthUsers(env),
  };
}

export class RuntimeAuthController {
  readonly mode: RuntimeAuthMode;
  private discovery: OAuthDiscovery | undefined;
  private readonly options: Required<
    Pick<
      RuntimeAuthOptions,
      "callbackPath" | "cookieName" | "logoutRedirectPath" | "scope" | "sessionTtlMs"
    >
  > &
    Omit<
      RuntimeAuthOptions,
      "callbackPath" | "cookieName" | "logoutRedirectPath" | "scope" | "sessionTtlMs"
    >;
  private readonly sessions = new Map<string, RuntimeAuthSession>();
  private readonly states = new Map<string, OAuthState>();

  constructor(options: RuntimeAuthOptions = {}) {
    this.mode = options.mode ?? "token";
    this.options = {
      ...options,
      callbackPath: options.callbackPath || "/auth/callback",
      cookieName: options.cookieName || DEFAULT_COOKIE_NAME,
      logoutRedirectPath: options.logoutRedirectPath || "/",
      scope: options.scope || DEFAULT_SCOPE,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    };
    if (this.mode === "oauth") this.assertOAuthConfigured();
    if (this.mode === "webauth") this.assertWebAuthConfigured();
  }

  defaultContext(): RuntimeAuthContext {
    const tenantId = this.options.defaultTenantId || "default";
    return {
      mode: this.mode,
      tenantId,
      tenantKey: tenantKey(tenantId),
      user: {
        id: "system",
        name: "System",
      },
    };
  }

  async handleAuthRoute(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<boolean> {
    const url = requestUrl(request);
    if (url.pathname === "/auth/session") {
      const session = this.authenticateHttp(request);
      sendJson(response, 200, session ? this.sessionPayload(session) : { authenticated: false });
      return true;
    }
    if (url.pathname === "/auth/logout") {
      this.logout(request, response);
      return true;
    }
    if (this.mode === "webauth" && url.pathname === "/auth/login") {
      await this.webAuthLogin(request, response).catch((error) => {
        sendHtml(response, 500, escapeHtml(error instanceof Error ? error.message : String(error)));
      });
      return true;
    }
    if (this.mode !== "oauth") return false;
    if (url.pathname === "/auth/login") {
      await this.oauthLogin(request, response).catch((error) => {
        sendHtml(response, 500, escapeHtml(error instanceof Error ? error.message : String(error)));
      });
      return true;
    }
    if (url.pathname === this.options.callbackPath) {
      await this.callback(request, response).catch((error) => {
        sendHtml(response, 401, escapeHtml(error instanceof Error ? error.message : String(error)));
      });
      return true;
    }
    return false;
  }

  authenticateHttp(request: http.IncomingMessage): RuntimeAuthContext | null {
    if (this.mode === "disabled" || this.mode === "token") return this.defaultContext();
    const sessionId = cookieValue(request, this.options.cookieName);
    if (!sessionId) return null;
    return this.sessionContext(sessionId);
  }

  authenticateWebSocket(request: http.IncomingMessage): RuntimeAuthContext | null {
    if (this.mode === "disabled" || this.mode === "token") return this.defaultContext();
    const sessionId = cookieValue(request, this.options.cookieName);
    if (!sessionId) return null;
    return this.sessionContext(sessionId);
  }

  requireHttpAuth(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): RuntimeAuthContext | null {
    const context = this.authenticateHttp(request);
    if (context) return context;
    if (this.acceptsHtml(request) && request.method !== "POST") {
      const url = requestUrl(request);
      redirect(response, `/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
      return null;
    }
    sendJson(response, 401, { error: "Authentication required." });
    return null;
  }

  runtimeRpcUrl(request: http.IncomingMessage, token?: string): string {
    const host = String(request.headers.host || "127.0.0.1");
    const protocol = requestProtocol(request);
    const scheme = protocol === "https" ? "wss" : "ws";
    const url = new URL(`${scheme}://${host}/agui-rpc`);
    if (this.mode === "token" && token) url.searchParams.set("token", token);
    return url.toString();
  }

  private async webAuthLogin(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const returnTo = this.safeReturnTo(requestUrl(request).searchParams.get("returnTo"));
    if (request.method !== "POST") {
      sendLoginForm(response, returnTo);
      return;
    }
    const form = await readForm(request);
    const username = string(form.get("username"));
    const password = string(form.get("password"));
    const next = this.safeReturnTo(string(form.get("returnTo")) || returnTo);
    const user = this.findWebAuthUser(username, password);
    if (!user) {
      sendLoginForm(response, next, "Invalid username or password.");
      return;
    }
    const context = this.contextFromWebAuthUser(user);
    const sessionId = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.options.sessionTtlMs;
    this.sessions.set(sessionId, { context, expiresAt });
    response.setHeader(
      "set-cookie",
      sessionCookie(this.options.cookieName, sessionId, {
        expiresAt,
        request,
        secure: this.options.cookieSecure,
      }),
    );
    redirect(response, next);
  }

  private async oauthLogin(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const endpoints = await this.oauthEndpoints();
    const returnTo = this.safeReturnTo(requestUrl(request).searchParams.get("returnTo"));
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    this.states.set(state, { codeVerifier, createdAt: Date.now(), nonce, returnTo });
    this.cleanupExpired();
    const authorize = new URL(endpoints.authorization_endpoint!);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", this.options.clientId!);
    authorize.searchParams.set("redirect_uri", this.redirectUri(request));
    authorize.searchParams.set("scope", this.options.scope);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    redirect(response, authorize.toString());
  }

  private async callback(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = requestUrl(request);
    const error = url.searchParams.get("error");
    if (error) {
      sendHtml(response, 401, `OAuth login failed: ${escapeHtml(error)}`);
      return;
    }
    const code = url.searchParams.get("code") || "";
    const stateId = url.searchParams.get("state") || "";
    const state = this.states.get(stateId);
    this.states.delete(stateId);
    if (!code || !state || Date.now() - state.createdAt > OAUTH_STATE_TTL_MS) {
      sendHtml(response, 401, "OAuth login state is missing or expired.");
      return;
    }
    const token = await this.exchangeCode(request, code, state.codeVerifier);
    const claims = await this.resolveClaims(token);
    const context = this.contextFromClaims(claims);
    const sessionId = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.options.sessionTtlMs;
    this.sessions.set(sessionId, { context, expiresAt });
    response.setHeader(
      "set-cookie",
      sessionCookie(this.options.cookieName, sessionId, {
        expiresAt,
        request,
        secure: this.options.cookieSecure,
      }),
    );
    redirect(response, state.returnTo);
  }

  private logout(request: http.IncomingMessage, response: http.ServerResponse): void {
    const sessionId = cookieValue(request, this.options.cookieName);
    if (sessionId) this.sessions.delete(sessionId);
    response.setHeader(
      "set-cookie",
      sessionCookie(this.options.cookieName, "", {
        expiresAt: 0,
        request,
        secure: this.options.cookieSecure,
      }),
    );
    redirect(response, this.options.logoutRedirectPath);
  }

  private sessionContext(sessionId: string): RuntimeAuthContext | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session.context;
  }

  private sessionPayload(context: RuntimeAuthContext): Record<string, unknown> {
    return {
      authenticated: true,
      mode: context.mode,
      tenant: { id: context.tenantId },
      user: {
        email: context.user.email,
        id: context.user.id,
        name: context.user.name,
      },
    };
  }

  private async oauthEndpoints(): Promise<OAuthDiscovery> {
    if (this.discovery) return this.discovery;
    let discovery: OAuthDiscovery = {
      authorization_endpoint: this.options.authorizationUrl,
      issuer: this.options.issuer,
      token_endpoint: this.options.tokenUrl,
      userinfo_endpoint: this.options.userInfoUrl,
    };
    if (
      this.options.issuer &&
      (!discovery.authorization_endpoint ||
        !discovery.token_endpoint ||
        !discovery.userinfo_endpoint)
    ) {
      const issuer = this.options.issuer.replace(/\/+$/, "");
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Failed to load OIDC discovery metadata: HTTP ${response.status}`);
      }
      const metadata = (await response.json()) as Record<string, unknown>;
      discovery = { ...metadata, ...compact(discovery) } as OAuthDiscovery;
    }
    if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
      throw new Error("OAuth authorization and token endpoints are required.");
    }
    this.discovery = discovery;
    return discovery;
  }

  private async exchangeCode(
    request: http.IncomingMessage,
    code: string,
    codeVerifier: string,
  ): Promise<Record<string, unknown>> {
    const endpoints = await this.oauthEndpoints();
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", this.redirectUri(request));
    body.set("client_id", this.options.clientId!);
    body.set("code_verifier", codeVerifier);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    const method =
      this.options.clientAuthMethod ?? (this.options.clientSecret ? "client_secret_basic" : "none");
    if (method === "client_secret_basic" && this.options.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(
        `${this.options.clientId}:${this.options.clientSecret}`,
      ).toString("base64")}`;
    } else if (method === "client_secret_post" && this.options.clientSecret) {
      body.set("client_secret", this.options.clientSecret);
    }
    const response = await fetch(endpoints.token_endpoint!, {
      body,
      headers,
      method: "POST",
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        `OAuth token exchange failed: ${String(payload.error_description ?? payload.error ?? response.status)}`,
      );
    }
    return payload;
  }

  private async resolveClaims(token: Record<string, unknown>): Promise<Record<string, unknown>> {
    const accessToken = string(token.access_token);
    const endpoints = await this.oauthEndpoints();
    if (accessToken && endpoints.userinfo_endpoint) {
      const response = await fetch(endpoints.userinfo_endpoint, {
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    }
    const idToken = string(token.id_token);
    if (idToken) return parseJwtPayload(idToken);
    throw new Error("OAuth provider did not return userinfo or an id_token.");
  }

  private contextFromClaims(claims: Record<string, unknown>): RuntimeAuthContext {
    const userId = string(claims.sub) || string(claims.user_id) || string(claims.id);
    if (!userId) throw new Error("OAuth profile is missing a stable user id.");
    const email = string(claims.email);
    const name = string(claims.name) || string(claims.preferred_username) || email || userId;
    const tenantId = this.tenantFromClaims(claims, email);
    const allowed = this.options.allowedTenants ?? [];
    if (allowed.length && !allowed.includes(tenantId)) {
      throw new Error("OAuth tenant is not allowed.");
    }
    return {
      mode: "oauth",
      tenantId,
      tenantKey: tenantKey(tenantId),
      user: {
        claims,
        email: email || undefined,
        id: userId,
        name: name || undefined,
      },
    };
  }

  private findWebAuthUser(username: string, password: string): RuntimeWebAuthUser | null {
    if (!username || !password) return null;
    for (const user of this.options.webAuthUsers ?? []) {
      if (!matchesSecret(username, user.username)) continue;
      if (user.passwordSha256) {
        const hash = createHash("sha256").update(password).digest("hex");
        if (matchesSecret(hash, user.passwordSha256.toLowerCase())) return user;
        continue;
      }
      if (user.password && matchesSecret(password, user.password)) return user;
    }
    return null;
  }

  private contextFromWebAuthUser(user: RuntimeWebAuthUser): RuntimeAuthContext {
    const tenantId = user.tenantId || this.options.defaultTenantId || "default";
    const allowed = this.options.allowedTenants ?? [];
    if (allowed.length && !allowed.includes(tenantId)) {
      throw new Error("WebAuth tenant is not allowed.");
    }
    return {
      mode: "webauth",
      tenantId,
      tenantKey: tenantKey(tenantId),
      user: {
        email: user.email,
        id: user.username,
        name: user.name || user.username,
      },
    };
  }

  private tenantFromClaims(claims: Record<string, unknown>, email: string): string {
    const explicitClaim = this.options.tenantClaim;
    const explicit = explicitClaim ? string(claims[explicitClaim]) : "";
    const inferred =
      explicit ||
      string(claims.tenant_id) ||
      string(claims.tenantId) ||
      string(claims.tid) ||
      string(claims.hd) ||
      emailDomain(email) ||
      this.options.defaultTenantId ||
      "default";
    return inferred.trim() || "default";
  }

  private redirectUri(request: http.IncomingMessage): string {
    const explicit = this.options.publicUrl || "";
    if (explicit) return `${explicit.replace(/\/+$/, "")}${this.options.callbackPath}`;
    const host = String(request.headers.host || "127.0.0.1");
    return `${requestProtocol(request)}://${host}${this.options.callbackPath}`;
  }

  private safeReturnTo(value: string | null): string {
    if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
    return value;
  }

  private acceptsHtml(request: http.IncomingMessage): boolean {
    const accept = String(request.headers.accept ?? "");
    return !accept || accept.includes("text/html") || accept.includes("*/*");
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (now - state.createdAt > OAUTH_STATE_TTL_MS) this.states.delete(id);
    }
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  private assertOAuthConfigured(): void {
    if (!this.options.clientId) throw new Error("OAuth auth requires AG_UI_OAUTH_CLIENT_ID.");
    if (!this.options.issuer && (!this.options.authorizationUrl || !this.options.tokenUrl)) {
      throw new Error(
        "OAuth auth requires AG_UI_OAUTH_ISSUER or explicit AG_UI_OAUTH_AUTHORIZATION_URL and AG_UI_OAUTH_TOKEN_URL.",
      );
    }
  }

  private assertWebAuthConfigured(): void {
    if (!this.options.webAuthUsers?.length) {
      throw new Error(
        "WebAuth requires AG_UI_WEBAUTH_PASSWORD, AG_UI_WEBAUTH_PASSWORD_SHA256, or AG_UI_WEBAUTH_USERS.",
      );
    }
  }
}

export function tenantKey(value: string): string {
  const normalized = value.trim().toLowerCase() || "default";
  const safe = normalized
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SAFE_SEGMENT_LIMIT);
  const hash = createHash("sha256")
    .update(value || "default")
    .digest("hex")
    .slice(0, 12);
  return `${safe || "tenant"}-${hash}`;
}

export function tenantPath(root: string, context: RuntimeAuthContext): string {
  return path.join(root, "tenants", context.tenantKey);
}

function normalizeAuthMode(value: unknown, fallback: RuntimeAuthMode = "token"): RuntimeAuthMode {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["disabled", "disable", "none", "off", "0"].includes(mode)) return "disabled";
  if (["webauth", "web-auth", "web", "password", "form"].includes(mode)) return "webauth";
  if (["oauth", "oidc"].includes(mode)) return "oauth";
  if (["token", "rpc-token", "rpc"].includes(mode)) return "token";
  return fallback;
}

function configuredWebAuthUsers(env: NodeJS.ProcessEnv): RuntimeWebAuthUser[] | undefined {
  const parsed = parseWebAuthUsers(env.AG_UI_WEBAUTH_USERS ?? env.AGUI_WEBAUTH_USERS);
  if (parsed.length) return parsed;
  const password = text(env.AG_UI_WEBAUTH_PASSWORD ?? env.AGUI_WEBAUTH_PASSWORD);
  const passwordSha256 = text(
    env.AG_UI_WEBAUTH_PASSWORD_SHA256 ?? env.AGUI_WEBAUTH_PASSWORD_SHA256,
  );
  if (!password && !passwordSha256) return undefined;
  return [
    {
      email: text(env.AG_UI_WEBAUTH_EMAIL ?? env.AGUI_WEBAUTH_EMAIL),
      name: text(env.AG_UI_WEBAUTH_NAME ?? env.AGUI_WEBAUTH_NAME),
      password,
      passwordSha256: passwordSha256?.toLowerCase(),
      tenantId: text(env.AG_UI_WEBAUTH_TENANT ?? env.AGUI_WEBAUTH_TENANT),
      username: text(env.AG_UI_WEBAUTH_USERNAME ?? env.AGUI_WEBAUTH_USERNAME) || "admin",
    },
  ];
}

function parseWebAuthUsers(value: unknown): RuntimeWebAuthUser[] {
  const raw = string(value);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AG_UI_WEBAUTH_USERS must be valid JSON.");
  }
  const values = Array.isArray(parsed)
    ? parsed
    : Object.entries(record(parsed)).map(([username, config]) => ({
        ...record(config),
        username,
      }));
  return values
    .map(normalizeWebAuthUser)
    .filter((user): user is RuntimeWebAuthUser => Boolean(user));
}

function normalizeWebAuthUser(value: unknown): RuntimeWebAuthUser | null {
  const source = record(value);
  const username = string(source.username);
  const password = text(source.password);
  const passwordSha256 = text(source.passwordSha256 ?? source.password_sha256)?.toLowerCase();
  if (!username || (!password && !passwordSha256)) return null;
  return {
    email: text(source.email),
    name: text(source.name),
    password,
    passwordSha256,
    tenantId: text(source.tenantId ?? source.tenant_id ?? source.tenant),
    username,
  };
}

function normalizeClientAuthMethod(
  value: unknown,
): RuntimeAuthOptions["clientAuthMethod"] | undefined {
  const method = String(value ?? "").trim();
  if (method === "client_secret_basic" || method === "client_secret_post" || method === "none") {
    return method;
  }
  return undefined;
}

function sessionCookie(
  name: string,
  value: string,
  options: { expiresAt: number; request: http.IncomingMessage; secure?: boolean },
): string {
  const secure = options.secure ?? requestProtocol(options.request) === "https";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(options.expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function cookieValue(request: http.IncomingMessage, name: string): string {
  const header = String(request.headers.cookie ?? "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] || "";
  if (!payload) return {};
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function requestProtocol(request: http.IncomingMessage): "http" | "https" {
  const forwarded = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim();
  if (forwarded === "https") return "https";
  return "http";
}

function requestUrl(request: http.IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
}

function redirect(response: http.ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><title>AGUI</title><body>${body}</body>`);
}

function sendLoginForm(response: http.ServerResponse, returnTo: string, error?: string): void {
  const message = error ? `<p style="color:#b42318;margin:0 0 16px">${escapeHtml(error)}</p>` : "";
  sendHtml(
    response,
    error ? 401 : 200,
    `<main style="box-sizing:border-box;display:grid;min-height:100vh;place-items:center;background:#f6f7f9;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <form method="post" action="/auth/login" style="width:min(360px,calc(100vw - 32px));box-sizing:border-box;background:#fff;border:1px solid #d8dde6;border-radius:8px;padding:24px;box-shadow:0 8px 32px rgba(15,23,42,.08)">
        <h1 style="font-size:20px;line-height:1.2;margin:0 0 8px">Sign in to AGUI</h1>
        <p style="color:#536071;font-size:14px;margin:0 0 20px">Use the account configured for this server.</p>
        ${message}
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <label style="display:block;font-size:13px;font-weight:600;margin:0 0 6px" for="username">Username</label>
        <input id="username" name="username" autocomplete="username" required style="box-sizing:border-box;width:100%;height:40px;border:1px solid #b8c1cc;border-radius:6px;padding:8px 10px;margin:0 0 14px;font:inherit">
        <label style="display:block;font-size:13px;font-weight:600;margin:0 0 6px" for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required style="box-sizing:border-box;width:100%;height:40px;border:1px solid #b8c1cc;border-radius:6px;padding:8px 10px;margin:0 0 18px;font:inherit">
        <button type="submit" style="width:100%;height:40px;border:0;border-radius:6px;background:#111827;color:#fff;font:inherit;font-weight:600;cursor:pointer">Sign in</button>
      </form>
    </main>`,
  );
}

function readForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > FORM_BODY_MAX_BYTES) {
        reject(new Error("Login request is too large."));
        request.destroy();
      }
    });
    request.on("error", reject);
    request.on("end", () => resolve(new URLSearchParams(body)));
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function safeTokenEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function matchesSecret(candidate: string, expected: string): boolean {
  return safeTokenEqual(candidate, expected);
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item != null && item !== ""),
  ) as Partial<T>;
}

function emailDomain(email: string): string {
  const index = email.lastIndexOf("@");
  return index >= 0 ? email.slice(index + 1).toLowerCase() : "";
}

function list(value: unknown): string[] | undefined {
  const items = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function bool(value: unknown): boolean | undefined {
  const textValue = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!textValue) return undefined;
  return ["1", "true", "yes", "on"].includes(textValue);
}

function seconds(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number * 1000 : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function text(value: unknown): string | undefined {
  const result = string(value);
  return result || undefined;
}
