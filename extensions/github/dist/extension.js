import { spawnSync } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
const TOKEN_KEY = "AGUI_GITHUB_TOKEN";
const REFRESH_TOKEN_KEY = "AGUI_GITHUB_REFRESH_TOKEN";
const ACCOUNT_KEY = "agui.github.account";
const AUTH_STATE_KEY = "agui.github.authState";
const OAUTH_CLIENT_ID = "Ov23li8hwhVdp7I2PLD8";
const OAUTH_SCOPE = "repo read:user";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_URL = "https://api.github.com";
const REPOSITORY_PAGE_LIMIT = 5;
const TREE_PAGE_SIZE = 20;
const ISSUE_COMMENT_LIMIT = 20;
const ISSUE_COMMENT_BODY_LIMIT = 900;
const TREE_REPOSITORY_LIMIT = 20;
const TREE_REQUEST_CONCURRENCY = 4;
const PULL_REQUEST_DIFF_FILE_LIMIT = 200;
const PULL_REQUEST_DIFF_PAGE_LIMIT = 3;
const PULL_REQUEST_DIFF_PATCH_LIMIT = 180_000;
const PULL_REQUEST_DIFF_PATCH_FILE_LIMIT = 40_000;
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const SESSION_TREE_CACHE_MS = 45_000;
const SESSION_TREE_CACHE_LIMIT = 24;
const SYSTEM_PROXY_CACHE_MS = 30_000;
const SYSTEM_PROXY_READ_TIMEOUT_MS = 1_000;
const GITHUB_ITEM_RENDERER = "agui.github.item";
const GITHUB_ISSUES_QUERY = `
  query AguiGitHubIssueTree($owner: String!, $name: String!, $first: Int!, $after: String, $states: [IssueState!], $commentsFirst: Int!) {
    viewer {
      login
    }
    repository(owner: $owner, name: $name) {
      issues(first: $first, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          body
          url
          state
          updatedAt
          closedAt
          author {
            login
            url
            avatarUrl
          }
          labels(first: 8) {
            nodes {
              name
            }
          }
          latestComments: comments(last: 1) {
            totalCount
            nodes {
              author {
                login
              }
              updatedAt
            }
          }
          discussionComments: comments(first: $commentsFirst) {
            totalCount
            nodes {
              author {
                login
                url
                avatarUrl
              }
              body
              url
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
`;
const GITHUB_PULL_REQUESTS_QUERY = `
  query AguiGitHubPullRequestTree($owner: String!, $name: String!, $first: Int!, $after: String, $states: [PullRequestState!]) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: $first, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          body
          url
          state
          isDraft
          merged
          mergedAt
          updatedAt
          reviewDecision
          author {
            login
            url
            avatarUrl
          }
          labels(first: 8) {
            nodes {
              name
            }
          }
          comments(last: 1) {
            totalCount
          }
          reviewRequests(first: 10) {
            totalCount
            nodes {
              requestedReviewer {
                ... on User {
                  login
                }
                ... on Team {
                  name
                  slug
                }
              }
            }
          }
        }
      }
    }
  }
`;
let systemProxyCache = { checkedAt: 0, settings: null };
const sessionTreeCache = new Map();
const authRefreshPromises = new Map();
export function activate(context) {
    context.commands.registerCommand("agui.github.sessionTree", async (input = {}) => {
        const record = objectValue(input);
        const language = stringValue(record.language);
        return githubSessionTreeNodes(context, language === "zh");
    });
    context.commands.registerCommand("agui.github.sessionTreeItems", async (input = {}) => {
        const record = objectValue(input);
        const language = stringValue(record.language);
        return githubSessionTreeItems(context, record, language === "zh");
    });
    context.commands.registerCommand("agui.github.authStatus", async (input = {}) => {
        const zh = inputLanguageZh(input);
        const token = stringValue(context.secrets.get(TOKEN_KEY));
        if (!token) {
            return {
                authenticated: false,
                clientIdConfigured: Boolean(githubOAuthClientId()),
                user: null,
            };
        }
        const cachedUser = githubUser(context.configuration.get(ACCOUNT_KEY));
        let user = cachedUser;
        try {
            user = await withGitHubAuth(context, zh, (accessToken) => fetchGitHubUser(accessToken, zh));
        }
        catch (error) {
            if (!isGitHubAuthenticationError(error)) {
                if (cachedUser) {
                    return {
                        authenticated: true,
                        clientIdConfigured: Boolean(githubOAuthClientId()),
                        refreshable: Boolean(githubRefreshToken(context)),
                        user: cachedUser,
                        warning: errorMessage(error),
                    };
                }
                throw error;
            }
            return {
                authenticated: false,
                clientIdConfigured: Boolean(githubOAuthClientId()),
                expired: true,
                error: errorMessage(error),
                user: null,
            };
        }
        return {
            authenticated: true,
            clientIdConfigured: Boolean(githubOAuthClientId()),
            refreshable: Boolean(githubRefreshToken(context)),
            user: user || githubUser(context.configuration.get(ACCOUNT_KEY)) || null,
        };
    });
    context.commands.registerCommand("agui.github.authStart", async (input = {}) => {
        const zh = inputLanguageZh(input);
        const clientId = githubOAuthClientId();
        if (!clientId) {
            throw new Error(githubText("oauthClientUnavailable", zh));
        }
        const payload = await requestGitHubForm(DEVICE_CODE_URL, {
            client_id: clientId,
            scope: OAUTH_SCOPE,
        }, githubText("authRequestFailed", zh));
        const deviceCode = stringValue(payload.device_code);
        const userCode = stringValue(payload.user_code);
        const verificationUri = stringValue(payload.verification_uri);
        const expiresIn = Number(payload.expires_in ?? 900);
        const intervalSeconds = Math.max(1, Number(payload.interval ?? 5));
        if (!deviceCode || !userCode || !verificationUri) {
            throw new Error(githubText("invalidDeviceResponse", zh));
        }
        return {
            deviceCode,
            userCode,
            verificationUri,
            expiresAt: Date.now() + expiresIn * 1000,
            intervalSeconds,
        };
    });
    context.commands.registerCommand("agui.github.authComplete", async (input = {}) => {
        const zh = inputLanguageZh(input);
        const clientId = githubOAuthClientId();
        const deviceCode = stringValue(objectValue(input).deviceCode);
        if (!clientId)
            throw new Error(githubText("oauthClientUnavailable", zh));
        if (!deviceCode)
            throw new Error(githubText("deviceCodeRequired", zh));
        const payload = await requestGitHubForm(ACCESS_TOKEN_URL, {
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }, githubText("authRequestFailed", zh));
        const error = stringValue(payload.error);
        if (error === "authorization_pending")
            return { status: "pending" };
        if (error === "slow_down") {
            return { status: "pending", intervalSeconds: Math.max(5, Number(payload.interval ?? 10)) };
        }
        if (error) {
            throw new Error(stringValue(payload.error_description) || `GitHub authentication failed: ${error}`);
        }
        const accessToken = stringValue(payload.access_token);
        if (!accessToken)
            throw new Error(githubText("missingAccessToken", zh));
        const user = await fetchGitHubUser(accessToken, zh);
        const issuedAt = Date.now();
        clearGitHubSessionTreeCache();
        return {
            status: "authenticated",
            accessToken,
            expiresAt: githubTokenExpiresAt(payload.expires_in, issuedAt),
            refreshToken: stringValue(payload.refresh_token),
            refreshTokenExpiresAt: githubTokenExpiresAt(payload.refresh_token_expires_in, issuedAt),
            user,
        };
    });
    context.commands.registerCommand("agui.github.repositories", async (input = {}) => {
        const zh = inputLanguageZh(input);
        return withGitHubAuth(context, zh, async (token) => {
            const repositories = await fetchGitHubRepositories(token);
            const query = stringValue(objectValue(input).query).trim().toLowerCase();
            return {
                repositories: repositories
                    .filter((item) => !query ||
                    item.fullName.toLowerCase().includes(query) ||
                    (item.description ?? "").toLowerCase().includes(query))
                    .slice(0, 200),
            };
        });
    });
    context.commands.registerCommand("agui.github.quickAction", async (input = {}) => githubQuickAction(context, input));
    context.commands.registerCommand("agui.github.pullRequestDiff", async (input = {}) => githubPullRequestDiff(context, input));
}
export function deactivate() { }
function githubOAuthClientId() {
    return (stringValue(process.env.AG_UI_GITHUB_OAUTH_CLIENT_ID) ||
        stringValue(process.env.AGUI_GITHUB_OAUTH_CLIENT_ID) ||
        OAUTH_CLIENT_ID).trim();
}
function inputLanguageZh(input) {
    const record = objectValue(input);
    return stringValue(record.language) === "zh" || record.zh === true;
}
function githubText(key, zh, values = {}) {
    const text = {
        authRequestFailed: zh ? "GitHub 授权请求失败。" : "GitHub authentication request failed.",
        authRefreshFailed: zh ? "GitHub 登录刷新失败。" : "GitHub sign-in refresh failed.",
        apiRequestFailed: zh ? "GitHub API 请求失败。" : "GitHub API request failed.",
        deviceCodeRequired: zh ? "缺少 GitHub 设备授权码。" : "GitHub device code is required.",
        invalidDeviceResponse: zh
            ? "GitHub 没有返回有效的设备授权响应。"
            : "GitHub did not return a valid device authorization response.",
        invalidUserResponse: zh
            ? "GitHub 用户响应中缺少登录名。"
            : "GitHub user response did not include a login.",
        missingAccessToken: zh ? "GitHub 没有返回访问令牌。" : "GitHub did not return an access token.",
        numberRequired: zh
            ? "需要有效的 GitHub issue 或 PR 编号。"
            : "A valid GitHub issue or pull request number is required.",
        oauthClientUnavailable: zh
            ? "GitHub OAuth client ID 不可用。"
            : "GitHub OAuth client ID is unavailable.",
        repositoryRequired: zh ? "需要有效的 GitHub 仓库。" : "A valid GitHub repository is required.",
        signInExpired: zh
            ? "GitHub 登录已失效，请重新登录。"
            : "GitHub sign-in expired. Please sign in again.",
        signInBeforeActions: zh
            ? "请先登录 GitHub，再执行 GitHub 操作。"
            : "Sign in to GitHub before running GitHub actions.",
        signInBeforeDiff: zh
            ? "请先登录 GitHub，再查看 PR 修改。"
            : "Sign in to GitHub before viewing pull request diffs.",
        signInBeforeRepositories: zh
            ? "请先登录 GitHub，再选择仓库。"
            : "Sign in to GitHub before choosing repositories.",
        signInRequired: zh ? "请先登录 GitHub。" : "Sign in to GitHub first.",
        unsupportedAction: zh
            ? `不支持的 GitHub 操作：${stringValue(values.action) || "unknown"}`
            : `Unsupported GitHub action: ${stringValue(values.action) || "unknown"}`,
    };
    return text[key] || key;
}
async function withGitHubAuth(context, zh, operation) {
    const token = githubAccessToken(context);
    if (!token)
        throw new Error(githubText("signInRequired", zh));
    try {
        return await operation(token);
    }
    catch (error) {
        if (!isGitHubAuthenticationError(error))
            throw error;
        const refreshedToken = await refreshGitHubAccessToken(context, zh);
        return operation(refreshedToken);
    }
}
function githubAccessToken(context) {
    const baseToken = stringValue(context.secrets.get(TOKEN_KEY));
    if (!baseToken)
        return "";
    const state = githubStoredAuthState(context, baseToken);
    return stringValue(state.accessToken) || baseToken;
}
function githubRefreshToken(context) {
    const baseToken = stringValue(context.secrets.get(TOKEN_KEY));
    if (!baseToken)
        return "";
    const state = githubStoredAuthState(context, baseToken);
    return stringValue(state.refreshToken) || stringValue(context.secrets.get(REFRESH_TOKEN_KEY));
}
function githubStoredAuthState(context, baseToken) {
    const state = objectValue(context.globalState.get(AUTH_STATE_KEY));
    return stringValue(state.baseTokenHash) === stableHash(baseToken) ? state : {};
}
async function refreshGitHubAccessToken(context, zh) {
    const baseToken = stringValue(context.secrets.get(TOKEN_KEY));
    if (!baseToken)
        throw new Error(githubText("signInRequired", zh));
    const refreshToken = githubRefreshToken(context);
    if (!refreshToken)
        throw new Error(githubText("signInExpired", zh));
    const baseTokenHash = stableHash(baseToken);
    const existing = authRefreshPromises.get(baseTokenHash);
    if (existing)
        return existing;
    const promise = refreshGitHubAccessTokenOnce(context, zh, baseTokenHash, refreshToken);
    authRefreshPromises.set(baseTokenHash, promise);
    try {
        return await promise;
    }
    finally {
        if (authRefreshPromises.get(baseTokenHash) === promise) {
            authRefreshPromises.delete(baseTokenHash);
        }
    }
}
async function refreshGitHubAccessTokenOnce(context, zh, baseTokenHash, refreshToken) {
    const clientId = githubOAuthClientId();
    if (!clientId)
        throw new Error(githubText("oauthClientUnavailable", zh));
    try {
        const issuedAt = Date.now();
        const payload = await requestGitHubForm(ACCESS_TOKEN_URL, {
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        }, githubText("authRefreshFailed", zh));
        const accessToken = stringValue(payload.access_token);
        if (!accessToken)
            throw new Error(githubText("missingAccessToken", zh));
        await context.globalState.update(AUTH_STATE_KEY, {
            accessToken,
            baseTokenHash,
            expiresAt: githubTokenExpiresAt(payload.expires_in, issuedAt),
            refreshToken: stringValue(payload.refresh_token) || refreshToken,
            refreshTokenExpiresAt: githubTokenExpiresAt(payload.refresh_token_expires_in, issuedAt),
            refreshedAt: Date.now(),
        });
        clearGitHubSessionTreeCache();
        return accessToken;
    }
    catch (error) {
        if (isGitHubAuthenticationError(error))
            throw new Error(githubText("signInExpired", zh));
        throw error;
    }
}
function githubTokenExpiresAt(value, issuedAt = Date.now()) {
    const seconds = Number(value ?? 0);
    return Number.isFinite(seconds) && seconds > 0 ? issuedAt + seconds * 1000 : 0;
}
async function githubQuickAction(context, input) {
    const zh = inputLanguageZh(input);
    return withGitHubAuth(context, zh, async (token) => {
        const action = stringValue(objectValue(input).action);
        const { number, repository } = githubIssueOrPullRequestInput(input, zh);
        clearGitHubSessionTreeCache();
        if (action === "closeIssue" || action === "closePullRequest") {
            const payload = objectValue(await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/issues/${number}`, token, {
                fallback: githubText("apiRequestFailed", zh),
                method: "PATCH",
                body: { state: "closed" },
            }));
            return {
                ok: true,
                action,
                repository,
                number,
                state: githubState(payload.state),
                htmlUrl: stringValue(payload.html_url),
                pullRequestStatus: action === "closePullRequest" ? "closed" : undefined,
            };
        }
        if (action === "reopenIssue") {
            const payload = objectValue(await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/issues/${number}`, token, {
                fallback: githubText("apiRequestFailed", zh),
                method: "PATCH",
                body: { state: "open" },
            }));
            return {
                ok: true,
                action,
                repository,
                number,
                state: githubState(payload.state),
                htmlUrl: stringValue(payload.html_url),
            };
        }
        if (action === "mergePullRequest") {
            const payload = objectValue(await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/pulls/${number}/merge`, token, {
                fallback: githubText("apiRequestFailed", zh),
                method: "PUT",
                body: { merge_method: "merge" },
            }));
            return {
                ok: true,
                action,
                repository,
                number,
                merged: payload.merged === true,
                message: stringValue(payload.message),
                sha: stringValue(payload.sha),
                state: payload.merged === true ? "merged" : "",
                pullRequestStatus: payload.merged === true ? "merged" : "",
            };
        }
        throw new Error(githubText("unsupportedAction", zh, { action: action || "unknown" }));
    });
}
async function githubPullRequestDiff(context, input) {
    const zh = inputLanguageZh(input);
    return withGitHubAuth(context, zh, async (token) => {
        const { number, repository } = githubIssueOrPullRequestInput(input, zh);
        const files = [];
        for (let page = 1; page <= PULL_REQUEST_DIFF_PAGE_LIMIT; page += 1) {
            const search = new URLSearchParams({
                page: String(page),
                per_page: "100",
            });
            const payload = await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/pulls/${number}/files?${search}`, token, { fallback: githubText("apiRequestFailed", zh) });
            const pageFiles = Array.isArray(payload) ? payload.map((item) => objectValue(item)) : [];
            files.push(...pageFiles);
            if (pageFiles.length < 100 || files.length >= PULL_REQUEST_DIFF_FILE_LIMIT)
                break;
        }
        let remainingPatchBudget = PULL_REQUEST_DIFF_PATCH_LIMIT;
        const normalizedFiles = files.slice(0, PULL_REQUEST_DIFF_FILE_LIMIT).map((file) => {
            const patch = stringValue(file.patch);
            const filePatchLimit = Math.max(0, Math.min(PULL_REQUEST_DIFF_PATCH_FILE_LIMIT, remainingPatchBudget));
            const truncated = patch.length > filePatchLimit;
            const nextPatch = patch.slice(0, filePatchLimit);
            remainingPatchBudget -= nextPatch.length;
            return {
                additions: numberValue(file.additions),
                blobUrl: stringValue(file.blob_url),
                changes: numberValue(file.changes),
                deletions: numberValue(file.deletions),
                filename: stringValue(file.filename),
                patch: nextPatch,
                previousFilename: stringValue(file.previous_filename),
                rawUrl: stringValue(file.raw_url),
                status: stringValue(file.status),
                truncated,
            };
        });
        return {
            ok: true,
            fileCount: normalizedFiles.length,
            files: normalizedFiles,
            number,
            repository,
            truncated: files.length > normalizedFiles.length ||
                files.length >= PULL_REQUEST_DIFF_FILE_LIMIT ||
                remainingPatchBudget <= 0,
        };
    });
}
function githubIssueOrPullRequestInput(input, zh) {
    const record = objectValue(input);
    const repository = stringValue(record.repository).trim();
    const number = Number(record.number ?? 0);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new Error(githubText("repositoryRequired", zh));
    }
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(githubText("numberRequired", zh));
    }
    return { number, repository };
}
async function requestGitHubForm(url, body, fallback = "GitHub authentication request failed.") {
    const response = await requestWithTimeout(url, {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "AGUI GitHub Extension",
        },
        body: new URLSearchParams(body),
    });
    return githubResponseRecord(response, fallback);
}
async function requestGitHubApi(pathname, token, options = {}) {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await requestWithTimeout(`${API_URL}${pathname}`, {
        method: stringValue(options.method) || "GET",
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            ...(body ? { "content-type": "application/json" } : {}),
            "user-agent": "AGUI GitHub Extension",
            "x-github-api-version": "2022-11-28",
        },
        body,
    });
    return githubResponseJson(response, stringValue(options.fallback) || "GitHub API request failed.");
}
async function requestGitHubGraphQL(query, variables, token) {
    const response = await requestWithTimeout(`${API_URL}/graphql`, {
        method: "POST",
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "AGUI GitHub Extension",
            "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
    });
    const payload = objectValue(await githubResponseJson(response, "GitHub GraphQL request failed."));
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length) {
        const message = errors
            .map((item) => stringValue(objectValue(item).message))
            .filter(Boolean)
            .join("; ") || "unknown error";
        throw new Error(`GitHub GraphQL request failed: ${message}`);
    }
    return objectValue(payload.data);
}
async function requestWithTimeout(url, options) {
    const proxyUrl = githubProxyUrl(url);
    return proxyUrl ? requestViaProxy(url, options, proxyUrl) : requestDirect(url, options);
}
function requestDirect(url, options) {
    const target = new URL(url);
    return makeHttpsRequest(target, options, {}).catch((error) => {
        const message = errorMessage(error);
        throw new Error(message.startsWith("GitHub") ? message : `GitHub request failed: ${message}`);
    });
}
function requestViaProxy(url, options, proxyUrl) {
    const proxy = new URL(proxyUrl);
    if (proxy.protocol === "http:")
        return requestViaHttpProxy(url, options, proxy);
    if (proxy.protocol === "socks:" || proxy.protocol === "socks5:" || proxy.protocol === "socks5h:")
        return requestViaSocksProxy(url, options, proxy);
    throw new Error(`GitHub proxy protocol is not supported: ${proxy.protocol}`);
}
function requestViaHttpProxy(url, options, proxy) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            const message = errorMessage(error);
            reject(new Error(message.startsWith("GitHub")
                ? message
                : `GitHub proxy request failed (${proxyHost(proxy)}): ${message}`));
        };
        const request = http.request({
            host: proxy.hostname,
            port: Number(proxy.port || 80),
            method: "CONNECT",
            path: `${target.hostname}:443`,
            headers: proxyHeaders(proxy, target),
        });
        const timeout = setTimeout(() => {
            request.destroy(new Error(`GitHub proxy connection timed out: ${proxyHost(proxy)}`));
        }, GITHUB_REQUEST_TIMEOUT_MS);
        request.once("connect", (response, socket, head) => {
            clearTimeout(timeout);
            if (response.statusCode !== 200) {
                socket.destroy();
                fail(new Error(`GitHub proxy CONNECT failed: HTTP ${response.statusCode}`));
                return;
            }
            const secureSocket = tls.connect({ socket, servername: target.hostname });
            if (head.length)
                secureSocket.unshift(head);
            makeHttpsRequest(target, options, { createConnection: () => secureSocket }).then((result) => {
                settled = true;
                resolve(result);
            }, fail);
        });
        request.once("error", (error) => {
            clearTimeout(timeout);
            fail(error);
        });
        request.end();
    });
}
function requestViaSocksProxy(url, options, proxy) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        let settled = false;
        let socket = null;
        let timeout = null;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            if (socket)
                socket.destroy();
            const message = errorMessage(error);
            reject(new Error(message.startsWith("GitHub")
                ? message
                : `GitHub SOCKS proxy request failed (${proxyHost(proxy)}): ${message}`));
        };
        socket = net.connect({
            host: proxy.hostname,
            port: Number(proxy.port || 1080),
        });
        timeout = setTimeout(() => {
            socket?.destroy(new Error(`GitHub SOCKS proxy connection timed out: ${proxyHost(proxy)}`));
        }, GITHUB_REQUEST_TIMEOUT_MS);
        socket.once("connect", () => {
            const reader = socketReader(socket);
            socks5Connect(socket, reader, proxy, target).then(() => {
                clearTimeout(timeout);
                const secureSocket = tls.connect({ socket, servername: target.hostname });
                makeHttpsRequest(target, options, { createConnection: () => secureSocket }).then((result) => {
                    settled = true;
                    resolve(result);
                }, fail);
            }, fail);
        });
        socket.once("error", (error) => {
            clearTimeout(timeout);
            fail(error);
        });
    });
}
function makeHttpsRequest(target, options, transport) {
    const body = requestBody(options.body);
    const headers = { ...options.headers };
    if (body && !headers["content-length"])
        headers["content-length"] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = https.request({
            ...transport,
            host: target.hostname,
            port: Number(target.port || 443),
            path: `${target.pathname}${target.search}`,
            method: options.method || "GET",
            headers,
        }, (response) => {
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) {
                    request.destroy(new Error("GitHub response exceeds the 2 MB limit."));
                    return;
                }
                chunks.push(Buffer.from(chunk));
            });
            response.on("end", () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({
                    ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
                    status: response.statusCode || 0,
                    text: async () => text,
                });
            });
        });
        const timeout = setTimeout(() => {
            request.destroy(new Error(`GitHub request timed out: ${target.hostname}`));
        }, GITHUB_REQUEST_TIMEOUT_MS);
        request.once("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });
        if (body)
            request.write(body);
        request.end();
    });
}
function requestBody(value) {
    if (value === undefined || value === null)
        return "";
    if (typeof value === "string" || Buffer.isBuffer(value))
        return value;
    if (value instanceof URLSearchParams)
        return value.toString();
    return String(value);
}
function socketReader(socket) {
    const chunks = [];
    let buffered = 0;
    let pending = null;
    const pump = () => {
        if (!pending || buffered < pending.size)
            return;
        const output = Buffer.alloc(pending.size);
        let offset = 0;
        while (offset < pending.size) {
            const chunk = chunks[0];
            const take = Math.min(chunk.length, pending.size - offset);
            chunk.copy(output, offset, 0, take);
            offset += take;
            buffered -= take;
            if (take === chunk.length)
                chunks.shift();
            else
                chunks[0] = chunk.subarray(take);
        }
        const resolve = pending.resolve;
        pending = null;
        resolve(output);
    };
    socket.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        buffered += chunk.length;
        pump();
    });
    socket.on("close", () => {
        if (!pending)
            return;
        const reject = pending.reject;
        pending = null;
        reject(new Error("SOCKS proxy closed the connection."));
    });
    return {
        read(size) {
            if (pending)
                throw new Error("Concurrent SOCKS proxy reads are not supported.");
            return new Promise((resolve, reject) => {
                pending = { size, resolve, reject };
                pump();
            });
        },
    };
}
async function socks5Connect(socket, reader, proxy, target) {
    const username = decodeURIComponent(proxy.username || "");
    const password = decodeURIComponent(proxy.password || "");
    const methods = username || password ? [0, 2] : [0];
    socket.write(Buffer.from([5, methods.length, ...methods]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 5)
        throw new Error("SOCKS proxy returned an invalid greeting.");
    if (greeting[1] === 0xff)
        throw new Error("SOCKS proxy rejected authentication methods.");
    if (greeting[1] === 2)
        await socks5Authenticate(socket, reader, username, password);
    else if (greeting[1] !== 0) {
        throw new Error(`SOCKS proxy selected unsupported method ${greeting[1]}.`);
    }
    const host = Buffer.from(target.hostname, "utf8");
    if (host.length > 255)
        throw new Error("GitHub host name is too long for SOCKS proxy.");
    const port = Number(target.port || 443);
    const request = Buffer.alloc(7 + host.length);
    request[0] = 5;
    request[1] = 1;
    request[2] = 0;
    request[3] = 3;
    request[4] = host.length;
    host.copy(request, 5);
    request.writeUInt16BE(port, 5 + host.length);
    socket.write(request);
    const head = await reader.read(4);
    if (head[0] !== 5)
        throw new Error("SOCKS proxy returned an invalid connect response.");
    if (head[1] !== 0) {
        throw new Error(`SOCKS proxy CONNECT failed: ${socks5ReplyMessage(head[1])}.`);
    }
    if (head[3] === 1)
        await reader.read(6);
    else if (head[3] === 3) {
        const length = await reader.read(1);
        await reader.read(length[0] + 2);
    }
    else if (head[3] === 4)
        await reader.read(18);
    else
        throw new Error("SOCKS proxy returned an invalid address type.");
}
async function socks5Authenticate(socket, reader, username, password) {
    const user = Buffer.from(username, "utf8");
    const pass = Buffer.from(password, "utf8");
    if (user.length > 255 || pass.length > 255) {
        throw new Error("SOCKS proxy credentials are too long.");
    }
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const response = await reader.read(2);
    if (response[1] !== 0)
        throw new Error("SOCKS proxy authentication failed.");
}
function socks5ReplyMessage(code) {
    return ({
        1: "general failure",
        2: "connection not allowed",
        3: "network unreachable",
        4: "host unreachable",
        5: "connection refused",
        6: "TTL expired",
        7: "command not supported",
        8: "address type not supported",
    }[code] || `error ${code}`);
}
function githubProxyUrl(url) {
    const target = new URL(url);
    const systemProxy = systemProxyForUrl(target);
    if (systemProxy)
        return systemProxy;
    if (isNoProxyHost(target.hostname))
        return "";
    return (stringValue(process.env.HTTPS_PROXY) ||
        stringValue(process.env.https_proxy) ||
        stringValue(process.env.ALL_PROXY) ||
        stringValue(process.env.all_proxy) ||
        stringValue(process.env.HTTP_PROXY) ||
        stringValue(process.env.http_proxy)).trim();
}
function systemProxyForUrl(target) {
    const settings = readSystemProxySettings();
    if (!settings)
        return "";
    if (isNoProxyHost(target.hostname, settings.exceptions, settings.excludeSimpleHostnames)) {
        return "";
    }
    if (target.protocol === "https:" && settings.https)
        return settings.https;
    if (settings.http)
        return settings.http;
    if (settings.socks)
        return settings.socks;
    return "";
}
function readSystemProxySettings() {
    if (process.platform !== "darwin")
        return null;
    if (Date.now() - systemProxyCache.checkedAt < SYSTEM_PROXY_CACHE_MS) {
        return systemProxyCache.settings;
    }
    const settings = readMacSystemProxySettings();
    systemProxyCache = { checkedAt: Date.now(), settings };
    return settings;
}
function readMacSystemProxySettings() {
    const result = spawnSync("/usr/sbin/scutil", ["--proxy"], {
        encoding: "utf8",
        timeout: SYSTEM_PROXY_READ_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0)
        return null;
    return macProxySettingsFromScutil(String(result.stdout || ""));
}
function macProxySettingsFromScutil(output) {
    const values = {};
    const exceptions = [];
    let readingExceptions = false;
    for (const line of output.split(/\r?\n/)) {
        if (/ExceptionsList\s*:\s*<array>/.test(line)) {
            readingExceptions = true;
            continue;
        }
        if (readingExceptions) {
            const item = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line);
            if (item) {
                exceptions.push(item[1]);
                continue;
            }
            if (/^\s*}\s*$/.test(line)) {
                readingExceptions = false;
                continue;
            }
        }
        const match = /^\s*([A-Za-z0-9]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (match)
            values[match[1]] = match[2];
    }
    const settings = {
        exceptions,
        excludeSimpleHostnames: values.ExcludeSimpleHostnames === "1",
        http: macProxyUrl(values, "HTTP", "http"),
        https: macProxyUrl(values, "HTTPS", "http"),
        socks: macProxyUrl(values, "SOCKS", "socks5"),
    };
    return settings.http || settings.https || settings.socks ? settings : null;
}
function macProxyUrl(values, prefix, protocol) {
    if (values[`${prefix}Enable`] !== "1")
        return "";
    const host = stringValue(values[`${prefix}Proxy`]);
    const port = Number(values[`${prefix}Port`] || 0);
    if (!host || !Number.isFinite(port) || port <= 0)
        return "";
    return `${protocol}://${host}:${port}`;
}
function isNoProxyHost(hostname, extraRules = [], excludeSimpleHostnames = false) {
    if (excludeSimpleHostnames && !hostname.includes("."))
        return true;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")
        return true;
    const rules = `${process.env.NO_PROXY || ""},${process.env.no_proxy || ""}`
        .split(",")
        .concat(extraRules)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    const host = hostname.toLowerCase();
    return rules.some((rule) => noProxyRuleMatches(host, rule));
}
function noProxyRuleMatches(host, rule) {
    if (rule === "*")
        return true;
    if (rule.includes("/"))
        return ipv4CidrMatches(host, rule);
    const normalized = rule.replace(/^\*\./, ".").replace(/^\./, "");
    return host === normalized || host.endsWith(`.${normalized}`);
}
function ipv4CidrMatches(host, rule) {
    const [network, prefixText] = rule.split("/");
    const prefix = Number(prefixText);
    const hostValue = ipv4ToInt(host);
    const networkValue = ipv4ToInt(network);
    if (hostValue === null || networkValue === null || !Number.isInteger(prefix))
        return false;
    if (prefix < 0 || prefix > 32)
        return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (hostValue & mask) === (networkValue & mask);
}
function ipv4ToInt(value) {
    const parts = value.split(".");
    if (parts.length !== 4)
        return null;
    let output = 0;
    for (const part of parts) {
        if (!/^\d+$/.test(part))
            return null;
        const byte = Number(part);
        if (byte < 0 || byte > 255)
            return null;
        output = (output << 8) | byte;
    }
    return output >>> 0;
}
function proxyHeaders(proxy, target) {
    const headers = { host: `${target.hostname}:443` };
    if (proxy.username || proxy.password) {
        headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    }
    return headers;
}
function proxyHost(proxy) {
    return `${proxy.hostname}:${proxy.port || 80}`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isGitHubAuthenticationError(error) {
    if (error instanceof GitHubRequestError) {
        const githubError = error.githubError.toLowerCase();
        const githubMessage = error.githubMessage.toLowerCase();
        return (error.status === 401 ||
            githubError === "bad_credentials" ||
            githubError === "bad_refresh_token" ||
            githubError === "incorrect_client_credentials" ||
            githubMessage === "bad credentials");
    }
    const message = errorMessage(error).toLowerCase();
    return (message.includes("bad credentials") ||
        message.includes("bad_refresh_token") ||
        message.includes("github 登录已失效") ||
        message.includes("github sign-in expired"));
}
async function githubResponseRecord(response, fallback) {
    const payload = await githubResponseJson(response, fallback);
    return objectValue(payload);
}
class GitHubRequestError extends Error {
    githubError;
    githubMessage;
    status;
    constructor(message, { githubError = "", githubMessage = "", status = 0, } = {}) {
        super(message);
        this.name = "GitHubRequestError";
        this.githubError = githubError;
        this.githubMessage = githubMessage;
        this.status = status;
    }
}
async function githubResponseJson(response, fallback) {
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    }
    catch {
        payload = {};
    }
    if (!response.ok) {
        const record = objectValue(payload);
        const githubError = stringValue(record.error);
        const githubMessage = stringValue(record.message);
        const message = stringValue(record.error_description) || githubError || githubMessage;
        const prefix = fallback.replace(/[.:。]+$/, "");
        throw new GitHubRequestError(message ? `${prefix}: ${message}` : `${fallback} HTTP ${response.status}`, {
            githubError,
            githubMessage,
            status: response.status,
        });
    }
    return payload;
}
async function fetchGitHubUser(token, zh = false) {
    const payload = objectValue(await requestGitHubApi("/user", token, { fallback: githubText("apiRequestFailed", zh) }));
    const login = stringValue(payload.login);
    if (!login)
        throw new Error(githubText("invalidUserResponse", zh));
    return {
        login,
        name: stringValue(payload.name) || undefined,
        avatarUrl: stringValue(payload.avatar_url) || undefined,
        htmlUrl: stringValue(payload.html_url) || undefined,
    };
}
async function fetchGitHubRepositories(token) {
    const output = [];
    const pages = await Promise.all(Array.from({ length: REPOSITORY_PAGE_LIMIT }, (_, index) => fetchGitHubRepositoryPage(token, index + 1)));
    for (const items of pages) {
        if (!items.length)
            break;
        for (const item of items) {
            const repo = objectValue(item);
            const owner = objectValue(repo.owner);
            const fullName = stringValue(repo.full_name);
            const ownerLogin = stringValue(owner.login);
            const name = stringValue(repo.name);
            if (!fullName || !ownerLogin || !name)
                continue;
            output.push({
                fullName,
                owner: ownerLogin,
                name,
                private: repo.private === true,
                description: stringValue(repo.description) || undefined,
                htmlUrl: stringValue(repo.html_url) || undefined,
            });
        }
    }
    return output;
}
async function fetchGitHubRepositoryPage(token, page) {
    const search = new URLSearchParams({
        affiliation: "owner,collaborator,organization_member",
        per_page: "100",
        sort: "updated",
        page: String(page),
    });
    const payload = await requestGitHubApi(`/user/repos?${search}`, token);
    return Array.isArray(payload) ? payload : [];
}
function githubUser(value) {
    const record = objectValue(value);
    const login = stringValue(record.login);
    if (!login)
        return undefined;
    return {
        login,
        name: stringValue(record.name) || undefined,
        avatarUrl: stringValue(record.avatarUrl) || undefined,
        htmlUrl: stringValue(record.htmlUrl) || undefined,
    };
}
async function githubSessionTreeNodes(context, zh) {
    const repositories = githubConfiguredRepositories(context.configuration.get("agui.github.repositories"));
    if (!repositories.length)
        return githubEmptySessionTreeNodes(zh);
    if (!stringValue(context.secrets.get(TOKEN_KEY)))
        return githubUnauthenticatedSessionTreeNodes(zh);
    try {
        return await withGitHubAuth(context, zh, async () => {
            const syncIssues = context.configuration.get("agui.github.syncIssues") !== false;
            const syncPullRequests = context.configuration.get("agui.github.syncPullRequests") !== false;
            const issueState = githubState(context.configuration.get("agui.github.issueState"));
            const pullRequestState = githubState(context.configuration.get("agui.github.pullRequestState"));
            const cacheKey = githubSessionTreeCacheKey({
                issueState,
                pullRequestState,
                repositories,
                syncIssues,
                syncPullRequests,
                zh,
            });
            const cached = sessionTreeCache.get(cacheKey);
            const now = Date.now();
            if (cached?.value && cached.expiresAt > now)
                return cached.value;
            const repositoryItems = repositories
                .slice(0, TREE_REPOSITORY_LIMIT)
                .map((repository, index) => githubRepositorySessionTreeNode({
                index,
                issueState,
                pullRequestState,
                repository,
                syncIssues,
                syncPullRequests,
                zh,
            }));
            sessionTreeCache.set(cacheKey, {
                expiresAt: Date.now() + SESSION_TREE_CACHE_MS,
                value: repositoryItems,
            });
            pruneGitHubSessionTreeCache();
            return repositoryItems;
        });
    }
    catch (error) {
        if (isGitHubAuthenticationError(error)) {
            return githubUnauthenticatedSessionTreeNodes(zh, githubText("signInExpired", zh));
        }
        throw error;
    }
}
async function githubSessionTreeItems(context, input, zh) {
    const payload = objectValue(input);
    const loadInput = objectValue(payload.input);
    const repository = stringValue(loadInput.repository);
    const kind = stringValue(loadInput.kind);
    const repoNodeId = stringValue(loadInput.repoNodeId);
    const state = githubState(loadInput.state);
    const cursor = stringValue(payload.cursor);
    const loadedCount = Math.max(0, Number(payload.loadedCount ?? 0));
    const configured = githubConfiguredRepositories(context.configuration.get("agui.github.repositories"));
    if (!configured.includes(repository) || !repoNodeId) {
        return {
            children: [
                githubEmptyFolderNode(`${stringValue(payload.nodeId) || "agui.github"}.invalid`, zh ? "仓库未配置" : "Repository is not configured", zh),
            ],
            hasMore: false,
        };
    }
    return withGitHubAuth(context, zh, async (token) => {
        let viewerLogin = stringValue(githubUser(context.configuration.get(ACCOUNT_KEY))?.login);
        if (kind === "issues" && !viewerLogin) {
            try {
                viewerLogin = stringValue((await fetchGitHubUser(token)).login);
            }
            catch {
                viewerLogin = "";
            }
        }
        const page = kind === "issues"
            ? await fetchGitHubIssuesPage(token, repository, state, viewerLogin, cursor)
            : kind === "pullRequests"
                ? await fetchGitHubPullRequestsPage(token, repository, state, cursor)
                : { items: [], cursor: "", hasMore: false };
        const children = page.items.length > 0
            ? page.items.map((item, index) => kind === "issues"
                ? githubIssueSessionTreeNode(repoNodeId, repository, item, loadedCount + index, state, zh)
                : githubPullRequestSessionTreeNode(repoNodeId, repository, item, loadedCount + index, state, zh))
            : loadedCount === 0
                ? [
                    githubEmptyFolderNode(`${repoNodeId}.${kind}.empty`, kind === "issues"
                        ? zh
                            ? "没有匹配的议题"
                            : "No matching issues"
                        : zh
                            ? "没有匹配的拉取请求"
                            : "No matching pull requests", zh),
                ]
                : [];
        return {
            children,
            cursor: page.cursor,
            hasMore: page.hasMore,
        };
    });
}
function githubSessionTreeCacheKey({ issueState, pullRequestState, repositories, syncIssues, syncPullRequests, zh, }) {
    return JSON.stringify({
        issueState,
        language: zh ? "zh" : "en",
        pullRequestState,
        repositories,
        syncIssues,
        syncPullRequests,
    });
}
function clearGitHubSessionTreeCache() {
    sessionTreeCache.clear();
}
function pruneGitHubSessionTreeCache() {
    if (sessionTreeCache.size <= SESSION_TREE_CACHE_LIMIT)
        return;
    const now = Date.now();
    for (const [key, entry] of sessionTreeCache) {
        if (!entry.promise && entry.expiresAt <= now)
            sessionTreeCache.delete(key);
    }
    while (sessionTreeCache.size > SESSION_TREE_CACHE_LIMIT) {
        const key = sessionTreeCache.keys().next().value;
        if (!key)
            return;
        sessionTreeCache.delete(key);
    }
}
function githubRepositorySessionTreeNode({ index, issueState, pullRequestState, repository, syncIssues, syncPullRequests, zh, }) {
    const repoNodeId = `agui.github.repo.${githubNodeSlug(repository)}.${index + 1}`;
    const children = [];
    if (syncIssues) {
        children.push({
            id: `${repoNodeId}.issues`,
            title: zh ? "议题" : "Issues",
            icon: "issue",
            kind: "folder",
            order: 1,
            badge: githubStateLabel(issueState, zh),
            hasMore: true,
            loadChildrenCommand: "agui.github.sessionTreeItems",
            loadMoreCommand: "agui.github.sessionTreeItems",
            loadInput: {
                kind: "issues",
                repoNodeId,
                repository,
                state: issueState,
            },
            children: [],
        });
    }
    if (syncPullRequests) {
        children.push({
            id: `${repoNodeId}.pullRequests`,
            title: zh ? "拉取请求" : "Pull Requests",
            icon: "git-pull-request",
            kind: "folder",
            order: 2,
            badge: githubStateLabel(pullRequestState, zh),
            hasMore: true,
            loadChildrenCommand: "agui.github.sessionTreeItems",
            loadMoreCommand: "agui.github.sessionTreeItems",
            loadInput: {
                kind: "pullRequests",
                repoNodeId,
                repository,
                state: pullRequestState,
            },
            children: [],
        });
    }
    return {
        id: repoNodeId,
        title: repository,
        icon: "github",
        kind: "folder",
        order: index + 1,
        children,
    };
}
function githubIssueSessionTreeNode(repoNodeId, repository, issue, index, state, zh) {
    const number = Number(issue.number);
    const title = stringValue(issue.title) || `#${number}`;
    const labels = githubLabels(issue.labels);
    const user = objectValue(issue.user);
    const author = stringValue(user.login);
    const authorHtmlUrl = stringValue(user.html_url) || githubUserHtmlUrl(author);
    const authorAvatarUrl = stringValue(user.avatar_url) || githubUserAvatarUrl(author);
    const htmlUrl = stringValue(issue.html_url);
    const comments = Number(issue.comments ?? 0);
    const issueComments = githubIssueComments(issue.agui_comments);
    const itemState = githubState(issue.state);
    const itemStatus = githubIssueStatus(issue);
    const body = stringValue(issue.body);
    return {
        id: `${repoNodeId}.issue.${number}`,
        title: `#${number} ${title}`,
        icon: "issue",
        kind: "session",
        badge: githubIssueStatusLabel(itemStatus, zh),
        description: githubItemDescription({ author, comments, htmlUrl, labels, zh }),
        order: index + 1,
        session: {
            title: `#${number} ${title}`,
            renderer: GITHUB_ITEM_RENDERER,
            initialMarkdown: githubIssueInitialMarkdown({
                author,
                authorHtmlUrl,
                body,
                comments,
                htmlUrl,
                itemState,
                issueComments,
                labels,
                number,
                repository,
                title,
                zh,
            }),
            developerInstructions: githubIssueDeveloperInstructions(repository, number, state, zh),
            metadata: {
                provider: "github",
                kind: "issue",
                repository,
                number,
                state: itemState,
                issueStatus: itemStatus,
                stateFilter: state,
                htmlUrl,
                title,
                author,
                authorHtmlUrl,
                authorAvatarUrl,
                comments,
                latestCommentAuthor: stringValue(issue.agui_latest_comment_author),
                labels,
                body,
                language: zh ? "zh" : "en",
                markdown: githubMarkdownSupplement(body, zh, issueComments, comments),
            },
        },
    };
}
function githubPullRequestSessionTreeNode(repoNodeId, repository, pullRequest, index, state, zh) {
    const number = Number(pullRequest.number);
    const title = stringValue(pullRequest.title) || `#${number}`;
    const user = objectValue(pullRequest.user);
    const author = stringValue(user.login);
    const authorHtmlUrl = stringValue(user.html_url) || githubUserHtmlUrl(author);
    const authorAvatarUrl = stringValue(user.avatar_url) || githubUserAvatarUrl(author);
    const htmlUrl = stringValue(pullRequest.html_url);
    const comments = Number(pullRequest.comments ?? 0);
    const draft = pullRequest.draft === true;
    const itemState = githubPullRequestState(pullRequest.state, pullRequest);
    const pullRequestStatus = githubPullRequestStatus(pullRequest);
    const reviewDecision = githubPullRequestReviewDecision(pullRequest.agui_review_decision);
    const reviewRequests = githubRequestedReviewers(pullRequest.agui_requested_reviewers);
    const reviewRequestCount = numberValue(pullRequest.agui_review_request_count);
    const labels = githubLabels(pullRequest.labels);
    const body = stringValue(pullRequest.body);
    return {
        id: `${repoNodeId}.pr.${number}`,
        title: `#${number} ${title}`,
        icon: "git-pull-request",
        kind: "session",
        badge: githubPullRequestStatusLabel(pullRequestStatus, zh),
        description: githubItemDescription({ author, comments, htmlUrl, labels, zh }),
        order: index + 1,
        session: {
            title: `#${number} ${title}`,
            renderer: GITHUB_ITEM_RENDERER,
            initialMarkdown: githubPullRequestInitialMarkdown({
                author,
                authorHtmlUrl,
                body,
                comments,
                draft,
                htmlUrl,
                itemState,
                number,
                pullRequestStatus,
                repository,
                reviewDecision,
                reviewRequestCount,
                reviewRequests,
                title,
                zh,
            }),
            developerInstructions: githubPullRequestDeveloperInstructions(repository, number, state, zh),
            metadata: {
                provider: "github",
                kind: "pull_request",
                repository,
                number,
                state: itemState,
                stateFilter: state,
                htmlUrl,
                title,
                author,
                authorHtmlUrl,
                authorAvatarUrl,
                comments,
                labels,
                body,
                draft,
                merged: itemState === "merged" || pullRequest.merged === true,
                pullRequestStatus,
                reviewDecision,
                reviewRequestCount,
                reviewRequests,
                language: zh ? "zh" : "en",
                markdown: githubMarkdownSupplement(body, zh),
            },
        },
    };
}
function githubEmptySessionTreeNodes(zh) {
    return [
        {
            id: "agui.github.empty",
            title: zh ? "未选择仓库" : "No repositories selected",
            icon: "github",
            kind: "folder",
            order: 1,
            description: zh
                ? "请在 GitHub 扩展配置中选择仓库。"
                : "Choose repositories in GitHub extension settings.",
        },
    ];
}
function githubUnauthenticatedSessionTreeNodes(zh, description = "") {
    return [
        {
            id: "agui.github.unauthenticated",
            title: zh ? "未登录 GitHub" : "GitHub is not signed in",
            icon: "github",
            kind: "folder",
            order: 1,
            description: description ||
                (zh
                    ? "登录后会同步已选择仓库的 issue 和 PR。"
                    : "Sign in to sync issues and pull requests."),
        },
    ];
}
async function fetchGitHubIssues(token, repository, state, viewerLogin) {
    return (await fetchGitHubIssuesPage(token, repository, state, viewerLogin)).items;
}
async function fetchGitHubIssuesPage(token, repository, state, viewerLogin, cursor = "") {
    try {
        return await fetchGitHubIssuesGraphQLPage(token, repository, state, viewerLogin, cursor);
    }
    catch {
        return fetchGitHubIssuesRestPage(token, repository, state, viewerLogin, cursor);
    }
}
async function fetchGitHubIssuesGraphQL(token, repository, state, viewerLogin) {
    return (await fetchGitHubIssuesGraphQLPage(token, repository, state, viewerLogin)).items;
}
async function fetchGitHubIssuesGraphQLPage(token, repository, state, viewerLogin, cursor = "") {
    const { owner, name } = githubRepositoryParts(repository);
    const data = await requestGitHubGraphQL(GITHUB_ISSUES_QUERY, {
        after: githubGraphQLAfterCursor(cursor),
        owner,
        name,
        first: TREE_PAGE_SIZE,
        states: githubGraphQLIssueStates(state),
        commentsFirst: ISSUE_COMMENT_LIMIT,
    }, token);
    const graphQLViewerLogin = stringValue(objectValue(data.viewer).login) || viewerLogin;
    const repositoryData = objectValue(data.repository);
    const issuesData = objectValue(repositoryData.issues);
    const nodes = Array.isArray(issuesData.nodes) ? issuesData.nodes : [];
    const pageInfo = objectValue(issuesData.pageInfo);
    const nextCursor = pageInfo.hasNextPage === true ? stringValue(pageInfo.endCursor) : "";
    return {
        items: nodes.map((item) => githubIssueFromGraphQL(item, graphQLViewerLogin)),
        cursor: nextCursor,
        hasMore: Boolean(nextCursor),
    };
}
function githubIssueFromGraphQL(value, viewerLogin) {
    const issue = objectValue(value);
    const author = objectValue(issue.author);
    const labels = objectValue(issue.labels);
    const labelNodes = Array.isArray(labels.nodes) ? labels.nodes : [];
    const latestComments = objectValue(issue.latestComments);
    const latestCommentNodes = Array.isArray(latestComments.nodes) ? latestComments.nodes : [];
    const latestComment = objectValue(latestCommentNodes[latestCommentNodes.length - 1]);
    const latestCommentAuthor = stringValue(objectValue(latestComment.author).login);
    const comments = objectValue(issue.discussionComments);
    const commentNodes = Array.isArray(comments.nodes) ? comments.nodes : [];
    const state = githubGraphQLIssueState(issue.state);
    const commentCount = Number(comments.totalCount ?? latestComments.totalCount ?? 0);
    return {
        number: Number(issue.number),
        title: stringValue(issue.title),
        body: stringValue(issue.body),
        html_url: stringValue(issue.url),
        state,
        updated_at: stringValue(issue.updatedAt),
        closed_at: stringValue(issue.closedAt),
        comments: Number.isFinite(commentCount) ? commentCount : 0,
        labels: labelNodes.map((item) => ({ name: stringValue(objectValue(item).name) })),
        user: {
            login: stringValue(author.login),
            html_url: stringValue(author.url),
            avatar_url: stringValue(author.avatarUrl),
        },
        agui_issue_status: githubIssueStatusFromParts({
            state,
            comments: commentCount,
            latestCommentAuthor,
            viewerLogin,
        }),
        agui_latest_comment_author: latestCommentAuthor,
        agui_comments: commentNodes.map((item) => githubIssueCommentFromGraphQL(item)),
    };
}
async function fetchGitHubIssuesRest(token, repository, state, viewerLogin) {
    return (await fetchGitHubIssuesRestPage(token, repository, state, viewerLogin)).items;
}
async function fetchGitHubIssuesRestPage(token, repository, state, viewerLogin, cursor = "") {
    const page = githubRestCursorPage(cursor);
    const search = new URLSearchParams({
        page: String(page),
        state,
        per_page: String(TREE_PAGE_SIZE),
        sort: "updated",
        direction: "desc",
    });
    const payload = await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/issues?${search}`, token);
    const issues = (Array.isArray(payload) ? payload : [])
        .map((item) => objectValue(item))
        .filter((item) => !item.pull_request)
        .slice(0, TREE_PAGE_SIZE);
    const items = await mapLimited(issues, TREE_REQUEST_CONCURRENCY, async (issue) => issueWithRestIssueStatus(token, repository, issue, viewerLogin));
    const hasMore = Array.isArray(payload) && payload.length >= TREE_PAGE_SIZE;
    return {
        items,
        cursor: hasMore ? githubRestCursor(page + 1) : "",
        hasMore,
    };
}
async function issueWithRestIssueStatus(token, repository, issue, viewerLogin) {
    const itemState = githubState(issue.state);
    const comments = Number(issue.comments ?? 0);
    const number = Number(issue.number);
    const issueComments = comments > 0 ? await fetchGitHubIssueComments(token, repository, number).catch(() => []) : [];
    let latestCommentAuthor = "";
    if (itemState !== "closed" && comments > 0) {
        if (comments <= issueComments.length) {
            latestCommentAuthor = stringValue(issueComments[issueComments.length - 1]?.author);
        }
        if (!latestCommentAuthor) {
            latestCommentAuthor = await fetchGitHubIssueLatestCommentAuthor(token, repository, number, comments).catch(() => "");
        }
    }
    return {
        ...issue,
        agui_issue_status: githubIssueStatusFromParts({
            state: itemState,
            comments,
            latestCommentAuthor,
            viewerLogin,
        }),
        agui_latest_comment_author: latestCommentAuthor,
        agui_comments: issueComments,
    };
}
async function fetchGitHubIssueComments(token, repository, number) {
    if (!Number.isFinite(number) || number <= 0)
        return [];
    const search = new URLSearchParams({
        per_page: String(ISSUE_COMMENT_LIMIT),
    });
    const payload = await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/issues/${number}/comments?${search}`, token);
    return (Array.isArray(payload) ? payload : []).map((item) => githubIssueCommentFromRest(item));
}
async function fetchGitHubIssueLatestCommentAuthor(token, repository, number, commentCount) {
    if (!Number.isFinite(number) || number <= 0)
        return "";
    const page = Math.max(1, Math.ceil(Math.max(1, Number(commentCount ?? 1)) / 100));
    const search = new URLSearchParams({
        page: String(page),
        per_page: "100",
    });
    const payload = await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/issues/${number}/comments?${search}`, token);
    const commentsPage = (Array.isArray(payload) ? payload : []).map((item) => objectValue(item));
    const last = objectValue(commentsPage[commentsPage.length - 1]);
    return stringValue(objectValue(last.user).login);
}
function githubIssueCommentFromGraphQL(value) {
    const comment = objectValue(value);
    const author = objectValue(comment.author);
    return {
        author: stringValue(author.login),
        authorHtmlUrl: stringValue(author.url),
        authorAvatarUrl: stringValue(author.avatarUrl),
        body: stringValue(comment.body),
        htmlUrl: stringValue(comment.url),
        createdAt: stringValue(comment.createdAt),
        updatedAt: stringValue(comment.updatedAt),
    };
}
function githubIssueCommentFromRest(value) {
    const comment = objectValue(value);
    const user = objectValue(comment.user);
    return {
        author: stringValue(user.login),
        authorHtmlUrl: stringValue(user.html_url),
        authorAvatarUrl: stringValue(user.avatar_url),
        body: stringValue(comment.body),
        htmlUrl: stringValue(comment.html_url),
        createdAt: stringValue(comment.created_at),
        updatedAt: stringValue(comment.updated_at),
    };
}
async function fetchGitHubPullRequests(token, repository, state) {
    return (await fetchGitHubPullRequestsPage(token, repository, state)).items;
}
async function fetchGitHubPullRequestsPage(token, repository, state, cursor = "") {
    try {
        return await fetchGitHubPullRequestsGraphQLPage(token, repository, state, cursor);
    }
    catch {
        return fetchGitHubPullRequestsRestPage(token, repository, state, cursor);
    }
}
async function fetchGitHubPullRequestsGraphQL(token, repository, state) {
    return (await fetchGitHubPullRequestsGraphQLPage(token, repository, state)).items;
}
async function fetchGitHubPullRequestsGraphQLPage(token, repository, state, cursor = "") {
    const { owner, name } = githubRepositoryParts(repository);
    const data = await requestGitHubGraphQL(GITHUB_PULL_REQUESTS_QUERY, {
        after: githubGraphQLAfterCursor(cursor),
        owner,
        name,
        first: TREE_PAGE_SIZE,
        states: githubGraphQLPullRequestStates(state),
    }, token);
    const repositoryData = objectValue(data.repository);
    const pullRequestsData = objectValue(repositoryData.pullRequests);
    const nodes = Array.isArray(pullRequestsData.nodes) ? pullRequestsData.nodes : [];
    const pageInfo = objectValue(pullRequestsData.pageInfo);
    const nextCursor = pageInfo.hasNextPage === true ? stringValue(pageInfo.endCursor) : "";
    return {
        items: nodes.map((item) => githubPullRequestFromGraphQL(item)),
        cursor: nextCursor,
        hasMore: Boolean(nextCursor),
    };
}
function githubPullRequestFromGraphQL(value) {
    const pullRequest = objectValue(value);
    const author = objectValue(pullRequest.author);
    const labels = objectValue(pullRequest.labels);
    const labelNodes = Array.isArray(labels.nodes) ? labels.nodes : [];
    const comments = objectValue(pullRequest.comments);
    const reviewRequests = objectValue(pullRequest.reviewRequests);
    const reviewRequestNodes = Array.isArray(reviewRequests.nodes) ? reviewRequests.nodes : [];
    const requestedReviewers = reviewRequestNodes
        .map((item) => githubRequestedReviewerFromGraphQL(objectValue(item).requestedReviewer))
        .filter(Boolean);
    const reviewRequestCount = Number(reviewRequests.totalCount ?? requestedReviewers.length);
    const state = githubGraphQLPullRequestState(pullRequest.state, pullRequest.merged === true);
    const draft = pullRequest.isDraft === true;
    const reviewDecision = githubPullRequestReviewDecision(pullRequest.reviewDecision);
    return {
        number: Number(pullRequest.number),
        title: stringValue(pullRequest.title),
        body: stringValue(pullRequest.body),
        html_url: stringValue(pullRequest.url),
        state,
        updated_at: stringValue(pullRequest.updatedAt),
        merged_at: stringValue(pullRequest.mergedAt),
        merged: pullRequest.merged === true,
        comments: numberValue(comments.totalCount),
        draft,
        labels: labelNodes.map((item) => ({ name: stringValue(objectValue(item).name) })),
        user: {
            login: stringValue(author.login),
            html_url: stringValue(author.url),
            avatar_url: stringValue(author.avatarUrl),
        },
        agui_pr_status: githubPullRequestStatusFromParts({
            draft,
            reviewDecision,
            reviewRequestCount,
            state,
        }),
        agui_review_decision: reviewDecision,
        agui_review_request_count: Number.isFinite(reviewRequestCount) ? reviewRequestCount : 0,
        agui_requested_reviewers: requestedReviewers,
    };
}
function githubGraphQLAfterCursor(cursor) {
    const value = stringValue(cursor);
    return value && !value.startsWith("rest:") ? value : undefined;
}
function githubRestCursorPage(cursor) {
    const value = stringValue(cursor);
    if (!value.startsWith("rest:"))
        return 1;
    const page = Number(value.slice("rest:".length));
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}
function githubRestCursor(page) {
    return `rest:${Math.max(1, Math.floor(Number(page) || 1))}`;
}
async function fetchGitHubPullRequestsRest(token, repository, state) {
    return (await fetchGitHubPullRequestsRestPage(token, repository, state)).items;
}
async function fetchGitHubPullRequestsRestPage(token, repository, state, cursor = "") {
    const page = githubRestCursorPage(cursor);
    const search = new URLSearchParams({
        page: String(page),
        state,
        per_page: String(TREE_PAGE_SIZE),
        sort: "updated",
        direction: "desc",
    });
    const payload = await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/pulls?${search}`, token);
    const pullRequests = (Array.isArray(payload) ? payload : []).map((item) => objectValue(item));
    const items = await mapLimited(pullRequests, TREE_REQUEST_CONCURRENCY, async (pullRequest) => pullRequestWithRestReviewStatus(token, repository, pullRequest));
    const hasMore = Array.isArray(payload) && payload.length >= TREE_PAGE_SIZE;
    return {
        items,
        cursor: hasMore ? githubRestCursor(page + 1) : "",
        hasMore,
    };
}
async function pullRequestWithRestReviewStatus(token, repository, pullRequest) {
    const number = Number(pullRequest.number);
    const draft = pullRequest.draft === true;
    const state = githubPullRequestState(pullRequest.state, pullRequest);
    const requestedReviewers = githubRequestedReviewersFromRest(pullRequest);
    const reviewRequestCount = requestedReviewers.length;
    let reviewDecision = "";
    if (number > 0 && state === "open" && !draft) {
        reviewDecision = await fetchGitHubPullRequestReviewDecision(token, repository, number).catch(() => "");
    }
    return {
        ...pullRequest,
        agui_pr_status: githubPullRequestStatusFromParts({
            draft,
            reviewDecision,
            reviewRequestCount,
            state,
        }),
        agui_review_decision: reviewDecision,
        agui_review_request_count: reviewRequestCount,
        agui_requested_reviewers: requestedReviewers,
    };
}
async function fetchGitHubPullRequestReviewDecision(token, repository, number) {
    const search = new URLSearchParams({ per_page: "100" });
    const payload = await requestGitHubApi(`/repos/${githubRepositoryPath(repository)}/pulls/${number}/reviews?${search}`, token);
    const latestByReviewer = new Map();
    for (const item of Array.isArray(payload) ? payload : []) {
        const review = objectValue(item);
        const reviewer = stringValue(objectValue(review.user).login);
        if (!reviewer)
            continue;
        const state = githubPullRequestReviewDecision(review.state);
        if (state === "DISMISSED")
            latestByReviewer.delete(reviewer);
        else if (state)
            latestByReviewer.set(reviewer, state);
    }
    const states = [...latestByReviewer.values()];
    if (states.includes("CHANGES_REQUESTED"))
        return "CHANGES_REQUESTED";
    if (states.includes("APPROVED"))
        return "APPROVED";
    return "";
}
function githubRepositoryPath(repository) {
    const { owner, name } = githubRepositoryParts(repository);
    return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
function githubRepositoryParts(repository) {
    const [owner = "", name = ""] = repository.split("/");
    return { owner, name };
}
function githubUserHtmlUrl(login) {
    return login ? `https://github.com/${encodeURIComponent(login)}` : "";
}
function githubUserAvatarUrl(login) {
    return login ? `https://github.com/${encodeURIComponent(login)}.png?size=80` : "";
}
function githubEmptyFolderNode(id, title, zh) {
    return {
        id,
        title,
        icon: "info",
        kind: "folder",
        description: zh
            ? "当前筛选条件下没有可同步的条目。"
            : "No synced items match the current filters.",
        order: 1,
    };
}
function githubItemDescription({ author, comments, htmlUrl, labels, zh }) {
    const parts = [];
    if (author)
        parts.push(zh ? `作者：${author}` : `Author: ${author}`);
    parts.push(zh ? `讨论：${comments} 条` : `Discussion: ${comments}`);
    if (labels.length)
        parts.push(zh ? `标签：${labels.join(", ")}` : `Labels: ${labels.join(", ")}`);
    if (htmlUrl)
        parts.push(htmlUrl);
    return parts.join(" · ");
}
function githubIssueInitialMarkdown({ author, authorHtmlUrl, body, comments, htmlUrl, itemState, issueComments, labels, number, repository, title, zh, }) {
    const bodyText = markdownBodyExcerpt(body, zh);
    return `### #${number} ${markdownHeadingText(title)}

- ${zh ? "仓库" : "Repository"}: ${repository}
- ${zh ? "类型" : "Type"}: ${zh ? "议题" : "Issue"}
- ${zh ? "状态" : "State"}: ${githubStateLabel(itemState, zh)}
- ${zh ? "作者" : "Author"}: ${authorHtmlUrl ? `[${markdownLinkText(`@${author}`)}](${authorHtmlUrl})` : markdownLinkText(author || (zh ? "未知作者" : "unknown author"))}
- ${zh ? "讨论" : "Discussion"}: ${commentCountLabel(comments, zh)}
${labels.length ? `- ${zh ? "标签" : "Labels"}: ${markdownLinkText(labelSummary(labels))}\n` : ""}- [#${number}](${htmlUrl})

${bodyText}

${githubIssueCommentsMarkdown(issueComments, comments, zh)}`;
}
function githubPullRequestInitialMarkdown({ author, authorHtmlUrl, body, comments, draft, htmlUrl, itemState, number, pullRequestStatus, repository, reviewDecision, reviewRequestCount, reviewRequests, title, zh, }) {
    const bodyText = markdownBodyExcerpt(body, zh);
    const reviewerSummary = reviewRequests.length
        ? ` (${reviewRequests.map((item) => `@${item}`).join(", ")})`
        : "";
    return `### #${number} ${markdownHeadingText(title)}

- ${zh ? "仓库" : "Repository"}: ${repository}
- ${zh ? "类型" : "Type"}: ${zh ? "拉取请求" : "Pull Request"}
- ${zh ? "状态" : "State"}: ${githubStateLabel(itemState, zh)}
- ${zh ? "Review 状态" : "Review status"}: ${githubPullRequestStatusLabel(pullRequestStatus, zh)}
- ${zh ? "草稿" : "Draft"}: ${draft ? (zh ? "是" : "yes") : zh ? "否" : "no"}
- ${zh ? "Review 请求" : "Review requests"}: ${numberValue(reviewRequestCount)}${reviewerSummary}
${reviewDecision ? `- ${zh ? "Review 结论" : "Review decision"}: ${githubPullRequestReviewDecisionLabel(reviewDecision, zh)}\n` : ""}- ${zh ? "作者" : "Author"}: ${authorHtmlUrl ? `[${markdownLinkText(`@${author}`)}](${authorHtmlUrl})` : markdownLinkText(author || (zh ? "未知作者" : "unknown author"))}
- ${zh ? "讨论" : "Discussion"}: ${commentCountLabel(comments, zh)}
- [#${number}](${htmlUrl})

${bodyText}`;
}
function githubMarkdownSupplement(body, zh, issueComments = [], comments = 0) {
    return {
        title: zh ? "正文" : "Body",
        content: [
            markdownBodyContent(body, zh),
            githubIssueCommentsMarkdown(issueComments, comments, zh),
        ]
            .filter(Boolean)
            .join("\n\n"),
    };
}
function githubIssueCommentsMarkdown(issueComments, comments, zh) {
    const total = Number.isFinite(Number(comments)) ? Number(comments) : 0;
    const items = githubIssueComments(issueComments);
    if (total <= 0)
        return "";
    const title = zh ? "#### 评论" : "#### Comments";
    if (!items.length) {
        return `${title}\n\n_${zh ? "评论暂未加载。" : "Comments were not loaded."}_`;
    }
    const rendered = items
        .map((comment, index) => {
        const author = comment.author ? `@${comment.author}` : zh ? "未知作者" : "unknown author";
        const date = commentDateLabel(comment.createdAt || comment.updatedAt);
        const headingParts = [
            `${index + 1}. ${markdownLinkText(author)}`,
            comment.htmlUrl && date ? `[${markdownLinkText(date)}](${comment.htmlUrl})` : date,
        ].filter(Boolean);
        return `##### ${headingParts.join(" - ")}\n\n${markdownCommentBodyContent(comment.body, zh)}`;
    })
        .join("\n\n");
    const hidden = Math.max(0, total - items.length);
    const note = hidden
        ? `\n\n_${zh ? `仅显示前 ${items.length} 条评论，另有 ${hidden} 条未加载。` : `Showing the first ${items.length} comments; ${hidden} more not loaded.`}_`
        : "";
    return `${title}\n\n${rendered}${note}`;
}
function commentCountLabel(comments, zh) {
    const count = Number.isFinite(Number(comments)) ? Number(comments) : 0;
    if (zh)
        return `${count} 条评论`;
    return `${count} ${count === 1 ? "comment" : "comments"}`;
}
function labelSummary(labels) {
    return labels.join(", ");
}
function markdownHeadingText(value) {
    return (String(value || "")
        .replace(/^\s*#+\s*/, "")
        .replace(/\s+/g, " ")
        .trim() || "GitHub");
}
function markdownLinkText(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
}
function githubIssueDeveloperInstructions(repository, number, state, zh) {
    return zh
        ? `当前虚拟会话绑定到 GitHub issue ${repository}#${number}，状态筛选为 ${state}。用户要求处理该 issue 时，先使用可用的 GitHub 工具读取 issue 详情、评论和讨论，再进行总结、回复草稿、标签调整、关闭或实现规划。除非连接的 GitHub 工具已经执行成功，否则不要声称已经评论、改标签、关闭 issue 或修改 GitHub。`
        : `This virtual session is bound to GitHub issue ${repository}#${number} with state filter ${state}. When the user asks to work on it, use available GitHub tools to read the issue details, comments, and discussion before summarizing, drafting replies, changing labels, closing, or planning implementation. Do not claim to have commented, labeled, closed, or modified GitHub unless a connected GitHub tool successfully performed that action.`;
}
function githubPullRequestDeveloperInstructions(repository, number, state, zh) {
    return zh
        ? `当前虚拟会话绑定到 GitHub PR ${repository}#${number}，状态筛选为 ${state}。用户要求处理该 PR 时，先使用可用的 GitHub 工具读取 PR 摘要、diff、checks、review comments 和讨论，再进行评审、修复建议、回复评论、准备合并或其他 GitHub 操作。除非连接的 GitHub 工具已经执行成功，否则不要声称已经 approve、merge、comment、push 或修改 GitHub。`
        : `This virtual session is bound to GitHub PR ${repository}#${number} with state filter ${state}. When the user asks to work on it, use available GitHub tools to read the PR summary, diff, checks, review comments, and discussion before reviewing, suggesting fixes, replying to comments, preparing merge work, or taking other GitHub actions. Do not claim to have approved, merged, commented, pushed, or modified GitHub unless a connected GitHub tool successfully performed that action.`;
}
function markdownBodyExcerpt(body, zh) {
    return `${zh ? "#### 正文" : "#### Body"}\n\n${markdownBodyContent(body, zh)}`;
}
function markdownBodyContent(body, zh) {
    const trimmed = String(body || "").trim();
    if (!trimmed)
        return zh ? "_没有描述正文。_" : "_No description body._";
    const excerpt = trimmed.length > 2_000 ? `${trimmed.slice(0, 2_000).trimEnd()}\n\n...` : trimmed;
    return closeUnterminatedMarkdownFence(excerpt);
}
function markdownCommentBodyContent(body, zh) {
    const trimmed = String(body || "").trim();
    if (!trimmed)
        return zh ? "_空评论。_" : "_Empty comment._";
    if (trimmed.length <= ISSUE_COMMENT_BODY_LIMIT)
        return closeUnterminatedMarkdownFence(trimmed);
    return closeUnterminatedMarkdownFence(`${trimmed.slice(0, ISSUE_COMMENT_BODY_LIMIT).trimEnd()}\n\n...`);
}
function closeUnterminatedMarkdownFence(markdown) {
    const fence = openMarkdownFence(markdown);
    if (!fence)
        return markdown;
    const separator = markdown.endsWith("\n") ? "" : "\n";
    return `${markdown}${separator}${fence.marker.repeat(fence.length)}`;
}
function openMarkdownFence(markdown) {
    let openFence = null;
    const lines = String(markdown || "").split(/\r?\n/);
    for (const line of lines) {
        const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
        if (!match)
            continue;
        const marker = match[2][0];
        const length = match[2].length;
        const trailing = match[3] || "";
        if (openFence) {
            if (marker === openFence.marker && length >= openFence.length && /^\s*$/.test(trailing)) {
                openFence = null;
            }
            continue;
        }
        openFence = { marker, length };
    }
    return openFence;
}
function commentDateLabel(value) {
    const timestamp = Date.parse(stringValue(value));
    if (!Number.isFinite(timestamp))
        return "";
    return new Date(timestamp)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, " UTC");
}
function githubLabels(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => {
        if (typeof item === "string")
            return item;
        return stringValue(objectValue(item).name);
    })
        .filter(Boolean)
        .slice(0, 8);
}
function githubIssueComments(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => {
        const comment = objectValue(item);
        return {
            author: stringValue(comment.author),
            authorAvatarUrl: stringValue(comment.authorAvatarUrl),
            authorHtmlUrl: stringValue(comment.authorHtmlUrl),
            body: stringValue(comment.body),
            createdAt: stringValue(comment.createdAt),
            htmlUrl: stringValue(comment.htmlUrl),
            updatedAt: stringValue(comment.updatedAt),
        };
    })
        .filter((item) => item.body || item.author || item.htmlUrl)
        .slice(0, ISSUE_COMMENT_LIMIT);
}
function githubRequestedReviewerFromGraphQL(value) {
    const reviewer = objectValue(value);
    return stringValue(reviewer.login) || stringValue(reviewer.slug) || stringValue(reviewer.name);
}
function githubRequestedReviewersFromRest(value) {
    const pullRequest = objectValue(value);
    const users = Array.isArray(pullRequest.requested_reviewers)
        ? pullRequest.requested_reviewers
            .map((item) => stringValue(objectValue(item).login))
            .filter(Boolean)
        : [];
    const teams = Array.isArray(pullRequest.requested_teams)
        ? pullRequest.requested_teams
            .map((item) => stringValue(objectValue(item).slug) || stringValue(objectValue(item).name))
            .filter(Boolean)
        : [];
    return [...users, ...teams].slice(0, 10);
}
function githubRequestedReviewers(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => stringValue(item))
        .filter(Boolean)
        .slice(0, 10);
}
async function mapLimited(items, concurrency, mapper) {
    const output = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            output[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return output;
}
function githubConfiguredRepositories(value) {
    if (!Array.isArray(value))
        return [];
    return [
        ...new Set(value
            .map((item) => String(item).trim())
            .filter((item) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item))),
    ].slice(0, 100);
}
function githubState(value) {
    if (value === "closed")
        return "closed";
    return value === "all" ? "all" : "open";
}
function githubPullRequestState(value, pullRequest = {}) {
    const record = objectValue(pullRequest);
    const state = String(value || record.state || "").toLowerCase();
    if (record.merged === true || stringValue(record.merged_at))
        return "merged";
    if (state === "merged")
        return "merged";
    if (state === "closed")
        return "closed";
    return "open";
}
function githubGraphQLPullRequestState(value, merged) {
    if (merged === true || String(value || "").toUpperCase() === "MERGED")
        return "merged";
    if (String(value || "").toUpperCase() === "CLOSED")
        return "closed";
    return "open";
}
function githubGraphQLPullRequestStates(value) {
    if (value === "closed")
        return ["CLOSED", "MERGED"];
    if (value === "open")
        return ["OPEN"];
    return null;
}
function githubPullRequestReviewDecision(value) {
    const decision = String(value || "").toUpperCase();
    if (decision === "APPROVED")
        return "APPROVED";
    if (decision === "CHANGES_REQUESTED")
        return "CHANGES_REQUESTED";
    if (decision === "REVIEW_REQUIRED")
        return "REVIEW_REQUIRED";
    if (decision === "DISMISSED")
        return "DISMISSED";
    return "";
}
function githubIssueStatus(issue) {
    const status = stringValue(issue.agui_issue_status);
    if (["open", "closed", "replied", "waiting_reply"].includes(status))
        return status;
    return githubIssueStatusFromParts({
        state: githubState(issue.state),
        comments: Number(issue.comments ?? 0),
        latestCommentAuthor: stringValue(issue.agui_latest_comment_author),
        viewerLogin: "",
    });
}
function githubIssueStatusFromParts({ state, comments, latestCommentAuthor, viewerLogin }) {
    if (githubState(state) === "closed")
        return "closed";
    const commentCount = Number.isFinite(Number(comments)) ? Number(comments) : 0;
    const latestAuthor = stringValue(latestCommentAuthor).trim().toLowerCase();
    const viewer = stringValue(viewerLogin).trim().toLowerCase();
    if (commentCount <= 0 || !latestAuthor || !viewer)
        return "open";
    return latestAuthor === viewer ? "replied" : "waiting_reply";
}
function githubIssueStatusLabel(value, zh) {
    if (value === "replied")
        return zh ? "已回复" : "replied";
    if (value === "waiting_reply")
        return zh ? "等待回复" : "waiting reply";
    return githubStateLabel(value, zh);
}
function githubPullRequestStatus(pullRequest) {
    const status = stringValue(pullRequest.agui_pr_status);
    if ([
        "open",
        "closed",
        "merged",
        "draft",
        "approved",
        "changes_requested",
        "review_requested",
        "review_required",
    ].includes(status)) {
        return status;
    }
    return githubPullRequestStatusFromParts({
        draft: pullRequest.draft === true,
        reviewDecision: pullRequest.agui_review_decision,
        reviewRequestCount: numberValue(pullRequest.agui_review_request_count),
        state: githubPullRequestState(pullRequest.state, pullRequest),
    });
}
function githubPullRequestStatusFromParts({ draft, reviewDecision, reviewRequestCount, state }) {
    const itemState = githubPullRequestState(state);
    if (itemState === "merged")
        return "merged";
    if (itemState === "closed")
        return "closed";
    if (draft === true)
        return "draft";
    const decision = githubPullRequestReviewDecision(reviewDecision);
    if (decision === "CHANGES_REQUESTED")
        return "changes_requested";
    if (Number(reviewRequestCount ?? 0) > 0)
        return "review_requested";
    if (decision === "REVIEW_REQUIRED")
        return "review_required";
    if (decision === "APPROVED")
        return "approved";
    return "open";
}
function githubPullRequestStatusLabel(value, zh) {
    if (value === "draft")
        return zh ? "草稿" : "draft";
    if (value === "approved")
        return zh ? "已批准" : "approved";
    if (value === "changes_requested")
        return zh ? "请求修改" : "changes requested";
    if (value === "review_requested")
        return zh ? "请求 Review" : "review requested";
    if (value === "review_required")
        return zh ? "需要 Review" : "review required";
    return githubStateLabel(value, zh);
}
function githubPullRequestReviewDecisionLabel(value, zh) {
    const decision = githubPullRequestReviewDecision(value);
    if (decision === "APPROVED")
        return zh ? "已批准" : "approved";
    if (decision === "CHANGES_REQUESTED")
        return zh ? "请求修改" : "changes requested";
    if (decision === "REVIEW_REQUIRED")
        return zh ? "需要 Review" : "review required";
    if (decision === "DISMISSED")
        return zh ? "已撤销" : "dismissed";
    return zh ? "无" : "none";
}
function githubGraphQLIssueState(value) {
    return String(value || "").toUpperCase() === "CLOSED" ? "closed" : "open";
}
function githubGraphQLIssueStates(value) {
    if (value === "closed")
        return ["CLOSED"];
    if (value === "open")
        return ["OPEN"];
    return null;
}
function githubStateLabel(value, zh) {
    if (zh && value === "merged")
        return "已合并";
    if (value === "merged")
        return "merged";
    if (zh && value === "closed")
        return "关闭";
    if (value === "closed")
        return "closed";
    if (zh)
        return value === "all" ? "全部" : "打开";
    return value === "all" ? "all" : "open";
}
function githubNodeSlug(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value) {
    return typeof value === "string" ? value : "";
}
function stableHash(value) {
    let hash = 5381;
    const text = stringValue(value);
    for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 33) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
}
function numberValue(value) {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
}
