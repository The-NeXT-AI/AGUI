import "./styles.css";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import {
  aguiCommand,
  githubLanguage,
  recordValue,
  safeHttpsUrl,
  stringValue,
  useAguiData,
} from "./common";
import { mount } from "./mount";

type Language = "en" | "zh";

type Repository = {
  description: string;
  fullName: string;
  private: boolean;
};

type AuthFlow = {
  deviceCode: string;
  expiresAt: number;
  intervalSeconds: number;
  userCode: string;
  verificationUri: string;
};

const text = {
  en: {
    account: "Account",
    all: "All",
    authExpired: "GitHub sign-in expired. Start again.",
    connected: "Connected",
    copied: "Copied",
    copyCode: "Copy code",
    copyFailed: "Could not copy code.",
    disconnect: "Disconnect",
    enterCode: "Enter this code on GitHub:",
    issueState: "Issue state",
    loading: "Loading...",
    noRepos: "No repositories found.",
    notSignedIn: "Sign in before choosing repositories.",
    open: "Open",
    openGitHub: "Open GitHub",
    private: "private",
    public: "public",
    pullRequestState: "Pull request state",
    refresh: "Refresh",
    repositories: "Repositories",
    save: "Save",
    saved: "Saved.",
    searchRepos: "Search repositories",
    selected: "selected",
    signIn: "Sign in with GitHub",
    signingIn: "Waiting for GitHub...",
    syncIssues: "Show issues",
    syncPullRequests: "Show pull requests",
  },
  zh: {
    account: "账号",
    all: "全部",
    authExpired: "GitHub 登录已过期，请重新开始。",
    connected: "已连接",
    copied: "已复制",
    copyCode: "复制代码",
    copyFailed: "无法复制代码。",
    disconnect: "断开连接",
    enterCode: "在 GitHub 页面输入此代码：",
    issueState: "议题状态",
    loading: "正在加载...",
    noRepos: "没有找到仓库。",
    notSignedIn: "先登录 GitHub，再选择要同步的仓库。",
    open: "打开",
    openGitHub: "打开 GitHub",
    private: "私有",
    public: "公开",
    pullRequestState: "拉取请求状态",
    refresh: "刷新",
    repositories: "仓库",
    save: "保存",
    saved: "已保存。",
    searchRepos: "搜索仓库",
    selected: "已选择",
    signIn: "登录 GitHub",
    signingIn: "等待 GitHub 授权...",
    syncIssues: "显示议题",
    syncPullRequests: "显示拉取请求",
  },
} as const;

function t(language: Language, key: keyof typeof text.en): string {
  return text[language][key] || text.en[key] || key;
}

function githubState(value: unknown): "open" | "all" {
  return value === "all" ? "all" : "open";
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function repositoriesFrom(value: unknown): Repository[] {
  const repositories = recordValue(value).repositories;
  return Array.isArray(repositories)
    ? repositories
        .map((item) => {
          const repo = recordValue(item);
          return {
            description: stringValue(repo.description),
            fullName: stringValue(repo.fullName),
            private: repo.private === true,
          };
        })
        .filter((repo) => repo.fullName)
    : [];
}

function flowFrom(value: unknown): AuthFlow {
  const flow = recordValue(value);
  return {
    deviceCode: stringValue(flow.deviceCode),
    expiresAt: Number(flow.expiresAt || 0),
    intervalSeconds: Math.max(1, Number(flow.intervalSeconds || 5)),
    userCode: stringValue(flow.userCode),
    verificationUri: stringValue(flow.verificationUri),
  };
}

function Configuration() {
  const data = useAguiData();
  const copyTimer = useRef<number>(0);
  const repositoryLoadId = useRef(0);
  const searchTimer = useRef<number>(0);
  const [auth, setAuth] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [flow, setFlow] = useState<AuthFlow | null>(null);
  const [language, setLanguage] = useState<Language>("en");
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"" | "error">("");
  const [query, setQuery] = useState("");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});

  const selectedRepos = useMemo(() => arrayOfStrings(values["agui.github.repositories"]), [values]);
  const selected = useMemo(() => new Set(selectedRepos), [selectedRepos]);
  const filteredRepositories = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return repositories;
    return repositories.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(normalized) ||
        repo.description.toLowerCase().includes(normalized),
    );
  }, [query, repositories]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const payload = recordValue(data);
    const nextLanguage = githubLanguage(payload.language);
    setLanguage(nextLanguage);
    setValues(recordValue(payload.values));
    setConfiguredSecrets(arrayOfStrings(payload.configuredSecrets));
    void (async () => {
      try {
        const nextAuth = await refreshStatus(nextLanguage);
        if (nextAuth.authenticated === true) await loadRepositories(query, nextLanguage);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : String(error), "error");
      }
    })();
  }, [data]);

  function showMessage(nextMessage: string, tone: "" | "error" = "") {
    setMessage(nextMessage);
    setMessageTone(tone);
  }

  function patchValues(nextValues: Record<string, unknown>) {
    setValues((current) => ({ ...current, ...nextValues }));
  }

  function boolValue(key: string, fallback = true): boolean {
    const value = values[key];
    return typeof value === "boolean" ? value : fallback;
  }

  function fieldValue(key: string, fallback = ""): string {
    const value = values[key];
    return typeof value === "string" ? value : fallback;
  }

  function command(id: string, args: unknown[] = [], commandLanguage = language): Promise<unknown> {
    return aguiCommand(
      id,
      id.startsWith("agui.github.") ? withLanguageArg(args, commandLanguage) : args,
    );
  }

  function withLanguageArg(args: unknown[], commandLanguage: Language): unknown[] {
    if (!Array.isArray(args) || args.length === 0) return [{ language: commandLanguage }];
    const first = args[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return [{ ...first, language: commandLanguage }, ...args.slice(1)];
    }
    return [{ language: commandLanguage }, ...args];
  }

  async function saveConfiguration(extra: Record<string, unknown> = {}, saveLanguage = language) {
    const nextValues = {
      "agui.github.repositories": selectedRepos,
      "agui.github.syncIssues": boolValue("agui.github.syncIssues"),
      "agui.github.syncPullRequests": boolValue("agui.github.syncPullRequests"),
      "agui.github.issueState": githubState(fieldValue("agui.github.issueState", "open")),
      "agui.github.pullRequestState": githubState(
        fieldValue("agui.github.pullRequestState", "open"),
      ),
      ...extra,
    };
    const result = recordValue(
      await command("agui.configuration.update", [nextValues], saveLanguage),
    );
    setConfiguredSecrets(
      arrayOfStrings(result.configuredSecrets).length
        ? arrayOfStrings(result.configuredSecrets)
        : configuredSecrets,
    );
    const persistedValues = recordValue(result.values);
    const merged = Object.keys(persistedValues).length ? persistedValues : nextValues;
    patchValues(
      Object.fromEntries(
        Object.entries(merged).filter(
          ([key]) => key !== "AGUI_GITHUB_TOKEN" && key !== "AGUI_GITHUB_REFRESH_TOKEN",
        ),
      ),
    );
    return result;
  }

  async function refreshStatus(statusLanguage = language) {
    const nextAuth = recordValue(await command("agui.github.authStatus", [], statusLanguage));
    setAuth(nextAuth);
    return nextAuth;
  }

  async function startSignIn() {
    setBusy(true);
    showMessage(t(language, "signingIn"));
    try {
      const nextFlow = flowFrom(await command("agui.github.authStart"));
      setFlow(nextFlow);
      command("agui.host.openExternal", [nextFlow.verificationUri]).catch((error) =>
        showMessage(error instanceof Error ? error.message : String(error), "error"),
      );
      void pollAuth(nextFlow, language);
    } catch (error) {
      setBusy(false);
      showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function pollAuth(currentFlow: AuthFlow, pollLanguage: Language) {
    try {
      while (Date.now() <= currentFlow.expiresAt) {
        await delay(currentFlow.intervalSeconds * 1000);
        const result = recordValue(
          await command(
            "agui.github.authComplete",
            [
              {
                deviceCode: currentFlow.deviceCode,
              },
            ],
            pollLanguage,
          ),
        );
        if (result.status === "pending") {
          if (result.intervalSeconds) {
            currentFlow.intervalSeconds = Math.max(1, Number(result.intervalSeconds || 5));
            setFlow({ ...currentFlow });
          }
          continue;
        }
        if (result.status === "authenticated") {
          await saveConfiguration(
            {
              AGUI_GITHUB_REFRESH_TOKEN: stringValue(result.refreshToken) || null,
              AGUI_GITHUB_TOKEN: stringValue(result.accessToken),
              "agui.github.account": {
                ...recordValue(result.user),
                refreshTokenExpiresAt: Number(result.refreshTokenExpiresAt || 0),
                refreshable: Boolean(result.refreshToken),
                tokenExpiresAt: Number(result.expiresAt || 0),
              },
            },
            pollLanguage,
          );
          setAuth({ authenticated: true, clientIdConfigured: true, user: result.user });
          setFlow(null);
          setBusy(false);
          showMessage(t(pollLanguage, "connected"));
          await loadRepositories(query, pollLanguage);
          await command("agui.extensions.refresh", [], pollLanguage);
          return;
        }
      }
      setFlow(null);
      setBusy(false);
      showMessage(t(pollLanguage, "authExpired"), "error");
    } catch (error) {
      setFlow(null);
      setBusy(false);
      showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function disconnect() {
    setBusy(true);
    showMessage("");
    try {
      await command("agui.configuration.update", [
        {
          AGUI_GITHUB_REFRESH_TOKEN: null,
          AGUI_GITHUB_TOKEN: null,
          "agui.github.account": {},
          "agui.github.repositories": [],
        },
      ]);
      patchValues({ "agui.github.account": {}, "agui.github.repositories": [] });
      setAuth({ authenticated: false, clientIdConfigured: true });
      setRepositories([]);
      setBusy(false);
      await command("agui.extensions.refresh");
    } catch (error) {
      setBusy(false);
      showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function loadRepositories(nextQuery = query, queryLanguage = language) {
    const loadId = repositoryLoadId.current + 1;
    repositoryLoadId.current = loadId;
    setLoadingRepositories(true);
    showMessage("");
    try {
      const result = await command(
        "agui.github.repositories",
        [{ query: nextQuery }],
        queryLanguage,
      );
      if (loadId !== repositoryLoadId.current) return;
      setRepositories(repositoriesFrom(result));
      setLoadingRepositories(false);
    } catch (error) {
      if (loadId !== repositoryLoadId.current) return;
      setLoadingRepositories(false);
      showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  }

  function scheduleRepositorySearch(nextQuery: string) {
    window.clearTimeout(searchTimer.current);
    if (auth.authenticated !== true) return;
    searchTimer.current = window.setTimeout(() => {
      void loadRepositories(nextQuery);
    }, 300);
  }

  async function saveAndRefresh() {
    setBusy(true);
    showMessage("");
    try {
      await saveConfiguration();
      await command("agui.extensions.refresh");
      setBusy(false);
      showMessage(t(language, "saved"));
    } catch (error) {
      setBusy(false);
      showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  }

  function toggleRepository(fullName: string) {
    const next = new Set(selectedRepos);
    if (next.has(fullName)) {
      next.delete(fullName);
    } else {
      next.add(fullName);
    }
    patchValues({ "agui.github.repositories": Array.from(next).sort() });
  }

  async function copyUserCode() {
    const userCode = flow?.userCode || "";
    if (!userCode) return;
    try {
      const copiedText = await copyText(userCode);
      if (!copiedText) throw new Error(t(language, "copyFailed"));
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function copyText(value: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall back to selection-based copy below.
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  }

  const user = recordValue(auth.user || values["agui.github.account"]);
  const signedIn = auth.authenticated === true;
  const authUrl = safeHttpsUrl(flow?.verificationUri);
  const titleClass = "font-semibold text-[var(--agui-fg)]";
  const mutedClass = "text-[var(--agui-muted)]";
  const buttonClass =
    "inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_90%,white)] px-2.5 py-1.5 font-semibold text-[var(--agui-fg)] no-underline disabled:cursor-not-allowed disabled:opacity-55";
  const primaryButton = `${buttonClass} border-[var(--agui-accent)] bg-[var(--agui-accent)] text-black`;
  const dangerButton = `${buttonClass} border-[color-mix(in_srgb,#ff5c5c_70%,var(--agui-border))] bg-transparent text-[#ff7676]`;
  const inputClass =
    "min-h-8 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_88%,black)] px-2 py-1.5 font-[inherit] text-[var(--agui-fg)]";

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-2">
        <div className={titleClass}>{t(language, "account")}</div>
        {signedIn ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_72%,transparent)] p-2.5">
            <div className="min-w-0">
              <div className={`${titleClass} truncate`}>
                {stringValue(user.login) || t(language, "connected")}
              </div>
              <div className={`${mutedClass} truncate`}>
                {stringValue(user.name) || t(language, "connected")}
              </div>
            </div>
            <button
              type="button"
              className={dangerButton}
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {t(language, "disconnect")}
            </button>
          </div>
        ) : (
          <>
            <div className={mutedClass}>{t(language, "notSignedIn")}</div>
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => void startSignIn()}
            >
              {busy ? t(language, "signingIn") : t(language, "signIn")}
            </button>
          </>
        )}

        {flow ? (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_72%,transparent)] p-2.5">
            <div className={mutedClass}>{t(language, "enterCode")}</div>
            <div className="flex max-w-full items-center gap-2 self-start">
              <div className="min-w-0 font-mono text-xl font-bold tracking-[0.18em] [overflow-wrap:anywhere] text-[var(--agui-fg)]">
                {flow.userCode}
              </div>
              <button
                type="button"
                className={`${buttonClass} relative grid size-8 min-h-8 min-w-8 place-items-center overflow-hidden p-0 ${
                  copied
                    ? "border-[color-mix(in_srgb,#2fd182_70%,var(--agui-border))] text-[#2fd182]"
                    : "text-[var(--agui-muted)]"
                }`}
                title={copied ? t(language, "copied") : t(language, "copyCode")}
                aria-label={copied ? t(language, "copied") : t(language, "copyCode")}
                onClick={() => void copyUserCode()}
              >
                {copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {authUrl ? (
              <a className={buttonClass} href={authUrl} rel="noopener noreferrer" target="_blank">
                {t(language, "openGitHub")}
              </a>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className={titleClass}>{t(language, "repositories")}</div>
        {signedIn ? (
          <>
            <div className="flex items-center gap-2 max-[720px]:flex-col max-[720px]:items-stretch">
              <input
                className={`${inputClass} flex-1`}
                placeholder={t(language, "searchRepos")}
                value={query}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setQuery(nextQuery);
                  scheduleRepositorySearch(nextQuery);
                }}
              />
              <button
                type="button"
                className={buttonClass}
                disabled={busy || loadingRepositories}
                onClick={() => void loadRepositories()}
              >
                {loadingRepositories ? (
                  <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                {loadingRepositories ? t(language, "loading") : t(language, "refresh")}
              </button>
            </div>
            <div className={mutedClass}>
              {selected.size} {t(language, "selected")}
            </div>
            <div className="max-h-[260px] overflow-auto rounded-lg border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_72%,transparent)]">
              {filteredRepositories.length ? (
                filteredRepositories.map((repo) => (
                  <label
                    key={repo.fullName}
                    className="grid grid-cols-[18px_1fr_auto] items-start gap-2 border-b border-[var(--agui-border)] px-2.5 py-2 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(repo.fullName)}
                      onChange={() => toggleRepository(repo.fullName)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-[var(--agui-fg)]">
                        {repo.fullName}
                      </span>
                      {repo.description ? (
                        <span className="mt-0.5 block truncate text-[var(--agui-muted)]">
                          {repo.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="rounded-full bg-[color-mix(in_srgb,var(--agui-surface)_80%,white)] px-1.5 py-0.5 text-[10px] text-[var(--agui-muted)]">
                      {repo.private ? t(language, "private") : t(language, "public")}
                    </span>
                  </label>
                ))
              ) : (
                <div className="p-2.5 text-[var(--agui-muted)]">{t(language, "noRepos")}</div>
              )}
            </div>
          </>
        ) : (
          <div className={mutedClass}>{t(language, "notSignedIn")}</div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-2 max-[720px]:grid-cols-1">
        <label className="flex flex-row items-center gap-2 text-[var(--agui-muted)]">
          <input
            type="checkbox"
            checked={boolValue("agui.github.syncIssues")}
            onChange={(event) => patchValues({ "agui.github.syncIssues": event.target.checked })}
          />
          <span>{t(language, "syncIssues")}</span>
        </label>
        <label className="flex flex-row items-center gap-2 text-[var(--agui-muted)]">
          <input
            type="checkbox"
            checked={boolValue("agui.github.syncPullRequests")}
            onChange={(event) =>
              patchValues({ "agui.github.syncPullRequests": event.target.checked })
            }
          />
          <span>{t(language, "syncPullRequests")}</span>
        </label>
        <label className="flex flex-col gap-1 text-[var(--agui-muted)]">
          <span>{t(language, "issueState")}</span>
          <select
            className={inputClass}
            value={githubState(fieldValue("agui.github.issueState"))}
            onChange={(event) => patchValues({ "agui.github.issueState": event.target.value })}
          >
            <option value="open">{t(language, "open")}</option>
            <option value="all">{t(language, "all")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[var(--agui-muted)]">
          <span>{t(language, "pullRequestState")}</span>
          <select
            className={inputClass}
            value={githubState(fieldValue("agui.github.pullRequestState"))}
            onChange={(event) =>
              patchValues({ "agui.github.pullRequestState": event.target.value })
            }
          >
            <option value="open">{t(language, "open")}</option>
            <option value="all">{t(language, "all")}</option>
          </select>
        </label>
      </section>

      <div className="flex items-center gap-2 max-[720px]:flex-col max-[720px]:items-stretch">
        <button
          type="button"
          className={primaryButton}
          disabled={busy}
          onClick={() => void saveAndRefresh()}
        >
          {t(language, "save")}
        </button>
        {message ? (
          <span className={messageTone === "error" ? "text-[#ff7676]" : "text-[var(--agui-muted)]"}>
            {message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

mount(<Configuration />);
