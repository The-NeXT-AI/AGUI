---
title: Configuration Reference
description: Environment variables and runtime settings used by AGUI.
---

This page summarizes the common configuration surfaces. Prefer product configuration and environment overrides over patching renderer internals.

## Data directory

| Variable              | Purpose                            |
| --------------------- | ---------------------------------- |
| `AG_UI_USER_DATA_DIR` | Preferred AGUI data directory.     |
| `AGUI_USER_DATA_DIR`  | Alternate AGUI data directory.     |
| `AG_UI_HOME`          | Home directory fallback.           |
| `AGUI_HOME`           | Alternate home directory fallback. |

If none are set, AGUI uses `~/.agui`. The runtime and provider store resolve these in the order shown; the extension services use a narrower chain — `AG_UI_HOME`, then `AGUI_HOME`, then `~/.agui` — so set `AG_UI_HOME` when extensions must follow a custom root.

Unless noted, every server-side variable below also accepts an `AGUI_`-prefixed alias (for example `AGUI_AUTH_MODE`); when both spellings are set, the `AG_UI_` value wins.

## Auth modes

`@agui/server` enables WebAuth by default; the runtime library's own fallback is `token`. Local development with `pnpm dev:pure-web` sets `AG_UI_AUTH_MODE=disabled` unless the variable is already preset.

| Mode       | Use case                                                       |
| ---------- | -------------------------------------------------------------- |
| `webauth`  | Built-in single or multi-user login form.                      |
| `oauth`    | External OAuth or OIDC provider.                               |
| `token`    | Shared RPC token behind a trusted single-tenant reverse proxy. |
| `disabled` | Local development or fully isolated trusted environments only. |

Common aliases are accepted, for example `oidc` for `oauth` and `rpc` for `token`.

## Configure WebAuth

```bash
AG_UI_WEBAUTH_USERNAME=admin
AG_UI_WEBAUTH_PASSWORD=...
```

`AG_UI_WEBAUTH_USERNAME` defaults to `admin` when unset. Set `AG_UI_WEBAUTH_PASSWORD_SHA256` to avoid storing a plaintext password in environment variables, or `AG_UI_WEBAUTH_USERS` to configure multiple users — a JSON array of `{ "username", "passwordSha256", "tenantId" }` objects or an object keyed by username. `AG_UI_WEBAUTH_EMAIL`, `AG_UI_WEBAUTH_NAME`, and `AG_UI_WEBAUTH_TENANT` fill in the profile fields of the single-user form.

## Configure OAuth

```bash
AG_UI_AUTH_MODE=oauth
AG_UI_PUBLIC_URL=https://agui.example.com
AG_UI_OAUTH_ISSUER=https://issuer.example.com
AG_UI_OAUTH_CLIENT_ID=...
AG_UI_OAUTH_CLIENT_SECRET=...
```

Issuer discovery can be replaced with explicit endpoints:

```bash
AG_UI_OAUTH_AUTHORIZATION_URL=...
AG_UI_OAUTH_TOKEN_URL=...
AG_UI_OAUTH_USERINFO_URL=...
```

| Variable                         | Purpose                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `AG_UI_OAUTH_SCOPE`              | Requested scope.                                                             |
| `AG_UI_OAUTH_CLIENT_AUTH_METHOD` | Token-endpoint client authentication method.                                 |
| `AG_UI_OAUTH_CALLBACK_PATH`      | Callback path (default `/auth/callback`).                                    |
| `AG_UI_OAUTH_TENANT_CLAIM`       | Claim used to derive the tenant.                                             |
| `AG_UI_AUTH_ALLOWED_TENANTS`     | Comma-separated tenant allowlist (`AG_UI_OAUTH_ALLOWED_TENANTS` also works). |
| `AG_UI_AUTH_COOKIE_NAME`         | Session cookie name.                                                         |
| `AG_UI_AUTH_COOKIE_SECURE`       | Force the `Secure` cookie attribute.                                         |
| `AG_UI_AUTH_SESSION_TTL_SECONDS` | Login session lifetime.                                                      |
| `AG_UI_AUTH_DEFAULT_TENANT`      | Tenant used when no claim resolves (default `default`).                      |
| `AG_UI_AUTH_LOGOUT_REDIRECT`     | Post-logout redirect path.                                                   |

After login the server derives the tenant from the claim named by `AG_UI_OAUTH_TENANT_CLAIM`, then from `tenant_id`/`tid`, then `hd`, and finally from the email domain.

## Token mode

```bash
AG_UI_AUTH_MODE=token
AG_UI_RPC_TOKEN=...
```

`AG_UI_RPC_TOKEN` sets the shared RPC token that clients must present in `token` mode.

## Workspace roots

The project picker's default roots come from `AG_UI_WORKSPACE_ROOTS`, separated by the platform path delimiter. For tenant-aware deployments, template `AG_UI_TENANT_WORKSPACE_ROOTS`:

```bash
AG_UI_TENANT_WORKSPACE_ROOTS=/srv/agui/tenants/{tenantId}/workspaces
```

Supported template values include `{tenant}`, `{tenantId}`, `{user}`, `{userId}`, and `{emailDomain}`. `{tenant}` expands to the hashed tenant key used under `userData/tenants/`, while `{tenantId}`, `{user}`, and `{userId}` expand to the raw identifiers — prefer `{tenantId}` when mapping onto existing project directories.

## Server listener

| Variable         | Purpose                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `AG_UI_WEB_HOST` | Bind address (default `127.0.0.1`; put a TLS-terminating reverse proxy in front for remote access). |
| `AG_UI_WEB_PORT` | Port (default `17371`).                                                                             |

## Product defaults

Common defaults include:

- `VITE_AGUI_PRODUCT_DISPLAY_NAME`
- `VITE_AGUI_DEFAULT_THEME`
- `VITE_AGUI_DEFAULT_MODEL`
- `VITE_AGUI_DEFAULT_EFFORT`
- `VITE_AGUI_DEFAULT_LANGUAGE`
- `VITE_AGUI_FEATURE_EXTENSIONS_PAGE`
- `VITE_AGUI_FEATURE_SCHEDULED_TASKS`
- `VITE_AGUI_FEATURE_SETTINGS_PAGE`

The customization guide lists the full set and runtime overrides. `VITE_AGUI_RPC_URL` overrides the JSON-RPC endpoint the renderer connects to (`dev:pure-web` sets it for you).

## Continue

- [Customization](/guides/customization/)
- [Providers](/guides/providers/)
