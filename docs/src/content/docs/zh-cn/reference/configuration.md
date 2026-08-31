---
title: 配置参考
description: AGUI 使用的环境变量与运行时设置。
---

本页汇总常见配置入口。优先使用产品配置和环境变量覆盖，不要直接 patch renderer 内部实现。

## 数据目录

| 变量                  | 用途                      |
| --------------------- | ------------------------- |
| `AG_UI_USER_DATA_DIR` | 首选 AGUI 数据目录。      |
| `AGUI_USER_DATA_DIR`  | 备用 AGUI 数据目录。      |
| `AG_UI_HOME`          | Home 目录 fallback。      |
| `AGUI_HOME`           | 备用 home 目录 fallback。 |

如果都没有设置，AGUI 使用 `~/.agui`。Runtime 和 provider store 按上表顺序解析；扩展服务使用更窄的解析链——`AG_UI_HOME`、`AGUI_HOME`、`~/.agui`——如果扩展也要跟随自定义根目录，请设置 `AG_UI_HOME`。

除特别说明外，下文所有服务端变量都接受 `AGUI_` 前缀别名（例如 `AGUI_AUTH_MODE`）；两个拼写同时设置时，`AG_UI_` 取值优先。

## 认证模式

`@agui/server` 默认启用 WebAuth；runtime 库自身的 fallback 是 `token`。使用 `pnpm dev:pure-web` 进行本地开发时，若未预设变量会设置 `AG_UI_AUTH_MODE=disabled`。

| 模式       | 适用场景                             |
| ---------- | ------------------------------------ |
| `webauth`  | 内置的单用户或多用户登录表单。       |
| `oauth`    | 外部 OAuth 或 OIDC provider。        |
| `token`    | 受信单租户反代后面的共享 RPC token。 |
| `disabled` | 仅用于本地开发或完全隔离的可信环境。 |

常见别名也可以使用，例如 `oidc` 等价于 `oauth`，`rpc` 等价于 `token`。

## 配置 WebAuth

```bash
AG_UI_WEBAUTH_USERNAME=admin
AG_UI_WEBAUTH_PASSWORD=...
```

`AG_UI_WEBAUTH_USERNAME` 未设置时默认为 `admin`。设置 `AG_UI_WEBAUTH_PASSWORD_SHA256` 可以避免在环境变量中保存明文密码；设置 `AG_UI_WEBAUTH_USERS` 可以配置多个用户——JSON 数组（元素为 `{ "username", "passwordSha256", "tenantId" }`）或以 username 为 key 的对象。`AG_UI_WEBAUTH_EMAIL`、`AG_UI_WEBAUTH_NAME` 和 `AG_UI_WEBAUTH_TENANT` 用于补全单用户表单的可选资料字段。

## 配置 OAuth

```bash
AG_UI_AUTH_MODE=oauth
AG_UI_PUBLIC_URL=https://agui.example.com
AG_UI_OAUTH_ISSUER=https://issuer.example.com
AG_UI_OAUTH_CLIENT_ID=...
AG_UI_OAUTH_CLIENT_SECRET=...
```

Discovery 也可以替换为显式的 endpoint：

```bash
AG_UI_OAUTH_AUTHORIZATION_URL=...
AG_UI_OAUTH_TOKEN_URL=...
AG_UI_OAUTH_USERINFO_URL=...
```

| 变量                             | 用途                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `AG_UI_OAUTH_SCOPE`              | 请求的 scope。                                                     |
| `AG_UI_OAUTH_CLIENT_AUTH_METHOD` | Token endpoint 的客户端认证方式。                                  |
| `AG_UI_OAUTH_CALLBACK_PATH`      | 回调路径（默认 `/auth/callback`）。                                |
| `AG_UI_OAUTH_TENANT_CLAIM`       | 用于推导 tenant 的 claim。                                         |
| `AG_UI_AUTH_ALLOWED_TENANTS`     | 逗号分隔的 tenant 白名单（也接受 `AG_UI_OAUTH_ALLOWED_TENANTS`）。 |
| `AG_UI_AUTH_COOKIE_NAME`         | 会话 cookie 名称。                                                 |
| `AG_UI_AUTH_COOKIE_SECURE`       | 强制 cookie 带 `Secure` 属性。                                     |
| `AG_UI_AUTH_SESSION_TTL_SECONDS` | 登录会话有效期。                                                   |
| `AG_UI_AUTH_DEFAULT_TENANT`      | claim 无法解析时使用的 tenant（默认 `default`）。                  |
| `AG_UI_AUTH_LOGOUT_REDIRECT`     | 登出后的重定向路径。                                               |

登录成功后，server 按 `AG_UI_OAUTH_TENANT_CLAIM` 指定的 claim、`tenant_id`/`tid`、`hd`、邮箱域名的顺序推导 tenant。

## Token 模式

```bash
AG_UI_AUTH_MODE=token
AG_UI_RPC_TOKEN=...
```

`AG_UI_RPC_TOKEN` 设置 `token` 模式下客户端必须携带的共享 RPC token。

## Workspace roots

项目选择器的默认根目录来自 `AG_UI_WORKSPACE_ROOTS`（按系统 path delimiter 分隔）。多租户部署可使用模板化的 `AG_UI_TENANT_WORKSPACE_ROOTS`：

```bash
AG_UI_TENANT_WORKSPACE_ROOTS=/srv/agui/tenants/{tenantId}/workspaces
```

支持的模板值包括 `{tenant}`、`{tenantId}`、`{user}`、`{userId}` 和 `{emailDomain}`。`{tenant}` 展开为 `userData/tenants/` 下的哈希 tenant key，`{tenantId}`、`{user}`、`{userId}` 展开为原始标识——映射到已有项目目录时优先使用 `{tenantId}`。

## Server 监听

| 变量             | 用途                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `AG_UI_WEB_HOST` | 绑定地址（默认 `127.0.0.1`；远程访问请在前置 TLS 反代后面部署）。 |
| `AG_UI_WEB_PORT` | 端口（默认 `17371`）。                                            |

## 产品默认值

常见默认值包括：

- `VITE_AGUI_PRODUCT_DISPLAY_NAME`
- `VITE_AGUI_DEFAULT_THEME`
- `VITE_AGUI_DEFAULT_MODEL`
- `VITE_AGUI_DEFAULT_EFFORT`
- `VITE_AGUI_DEFAULT_LANGUAGE`
- `VITE_AGUI_FEATURE_EXTENSIONS_PAGE`
- `VITE_AGUI_FEATURE_SCHEDULED_TASKS`
- `VITE_AGUI_FEATURE_SETTINGS_PAGE`

完整默认值与运行时覆盖见[产品定制](/zh-cn/guides/customization/)。`VITE_AGUI_RPC_URL` 覆盖 renderer 连接的 JSON-RPC endpoint（`dev:pure-web` 会自动设置）。

## 继续阅读

- [产品定制](/zh-cn/guides/customization/)
- [Provider](/zh-cn/guides/providers/)
