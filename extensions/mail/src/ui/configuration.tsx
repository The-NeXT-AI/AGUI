import "./styles.css";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, PlugZap, Save, Trash2 } from "lucide-react";
import {
  aguiCommand,
  boolValue,
  mailLanguage,
  numberValue,
  recordValue,
  stringValue,
  useAguiData,
} from "./common";
import { mount } from "./mount";

type Language = "en" | "zh";
type Security = "tls" | "starttls" | "plain";

type Account = {
  displayName: string;
  email: string;
  incomingHost: string;
  incomingPort: number;
  incomingSecurity: Security;
  outgoingHost: string;
  outgoingPort: number;
  outgoingSecurity: Security;
  rejectUnauthorized: boolean;
  username: string;
};

const ACCOUNT_KEY = "agui.mail.account";
const MESSAGES_PER_PAGE_KEY = "agui.mail.messagesPerPage";
const PREVIEW_LINES_KEY = "agui.mail.previewLines";
const PASSWORD_KEY = "AGUI_MAIL_PASSWORD";

const text = {
  en: {
    account: "Account",
    appPassword: "App password",
    clear: "Disconnect",
    displayName: "Display name",
    email: "Email",
    incoming: "POP3",
    incomingHost: "POP3 host",
    incomingPort: "POP3 port",
    keepPassword: "Leave blank to keep the saved password.",
    messagesPerPage: "Messages per page",
    outgoing: "SMTP",
    outgoingHost: "SMTP host",
    outgoingPort: "SMTP port",
    passwordSaved: "Password saved",
    plain: "Plain",
    previewLines: "Preview lines",
    rejectUnauthorized: "Verify TLS certificates",
    save: "Save",
    saved: "Saved.",
    security: "Security",
    starttls: "STARTTLS",
    test: "Test",
    tls: "TLS",
    username: "Username",
  },
  zh: {
    account: "账号",
    appPassword: "应用密码",
    clear: "断开连接",
    displayName: "显示名称",
    email: "邮箱地址",
    incoming: "POP3",
    incomingHost: "POP3 主机",
    incomingPort: "POP3 端口",
    keepPassword: "留空则保留已保存的密码。",
    messagesPerPage: "每页邮件数",
    outgoing: "SMTP",
    outgoingHost: "SMTP 主机",
    outgoingPort: "SMTP 端口",
    passwordSaved: "已保存密码",
    plain: "明文",
    previewLines: "预览行数",
    rejectUnauthorized: "验证 TLS 证书",
    save: "保存",
    saved: "已保存。",
    security: "加密方式",
    starttls: "STARTTLS",
    test: "测试连接",
    tls: "TLS",
    username: "用户名",
  },
} as const;

const emptyAccount: Account = {
  displayName: "",
  email: "",
  incomingHost: "",
  incomingPort: 995,
  incomingSecurity: "tls",
  outgoingHost: "",
  outgoingPort: 465,
  outgoingSecurity: "tls",
  rejectUnauthorized: true,
  username: "",
};

function t(language: Language, key: keyof typeof text.en): string {
  return text[language][key] || text.en[key] || key;
}

function Configuration() {
  const data = useAguiData();
  const [account, setAccount] = useState<Account>(emptyAccount);
  const [busy, setBusy] = useState(false);
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([]);
  const [language, setLanguage] = useState<Language>("en");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"" | "error" | "success">("");
  const [messagesPerPage, setMessagesPerPage] = useState(20);
  const [password, setPassword] = useState("");
  const [previewLines, setPreviewLines] = useState(20);

  const passwordConfigured = useMemo(
    () => configuredSecrets.includes(PASSWORD_KEY),
    [configuredSecrets],
  );

  useEffect(() => {
    const payload = recordValue(data);
    const nextLanguage = mailLanguage(payload.language);
    const values = recordValue(payload.values);
    setLanguage(nextLanguage);
    document.documentElement.lang = nextLanguage;
    setConfiguredSecrets(arrayOfStrings(payload.configuredSecrets));
    setAccount(accountFrom(values[ACCOUNT_KEY]));
    setMessagesPerPage(clamp(numberValue(values[MESSAGES_PER_PAGE_KEY], 20), 1, 50));
    setPreviewLines(clamp(numberValue(values[PREVIEW_LINES_KEY], 20), 0, 80));
  }, [data]);

  function patchAccount(patch: Partial<Account>) {
    setAccount((current) => ({ ...current, ...patch }));
  }

  function command(id: string, args: unknown[] = []) {
    if (!id.startsWith("agui.mail.")) return aguiCommand(id, args);
    const first = recordValue(args[0]);
    return aguiCommand(id, [{ ...first, language }, ...args.slice(1)]);
  }

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const storedAccount = accountForStorage(account);
      const update: Record<string, unknown> = {
        [ACCOUNT_KEY]: storedAccount,
        [MESSAGES_PER_PAGE_KEY]: clamp(messagesPerPage, 1, 50),
        [PREVIEW_LINES_KEY]: clamp(previewLines, 0, 80),
      };
      if (password.trim()) update[PASSWORD_KEY] = password;
      const result = recordValue(await aguiCommand("agui.configuration.update", [update]));
      const values = recordValue(result.values);
      setConfiguredSecrets(arrayOfStrings(result.configuredSecrets));
      setAccount(accountFrom(values[ACCOUNT_KEY] || update[ACCOUNT_KEY]));
      setMessagesPerPage(clamp(numberValue(values[MESSAGES_PER_PAGE_KEY], messagesPerPage), 1, 50));
      setPreviewLines(clamp(numberValue(values[PREVIEW_LINES_KEY], previewLines), 0, 80));
      setPassword("");
      await aguiCommand("agui.extensions.refresh");
      setMessage(t(language, "saved"));
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setMessage("");
    try {
      const result = recordValue(
        await command("agui.mail.testConnection", [
          {
            account: accountForStorage(account),
            password: password.trim() || undefined,
          },
        ]),
      );
      const incoming = recordValue(result.incoming);
      const outgoing = recordValue(result.outgoing);
      setMessage(
        [stringValue(incoming.message), stringValue(outgoing.message)].filter(Boolean).join(" "),
      );
      setMessageTone(result.ok === true ? "success" : "error");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setMessage("");
    try {
      await aguiCommand("agui.configuration.update", [
        {
          [ACCOUNT_KEY]: {},
          [PASSWORD_KEY]: null,
        },
      ]);
      setAccount(emptyAccount);
      setConfiguredSecrets([]);
      setPassword("");
      await aguiCommand("agui.extensions.refresh");
      setMessage(t(language, "saved"));
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "min-h-8 w-full rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_88%,black)] px-2 py-1.5 font-[inherit] text-[var(--agui-fg)] outline-none focus:border-[var(--agui-accent)]";
  const buttonClass =
    "inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_90%,white)] px-2.5 py-1.5 font-semibold text-[var(--agui-fg)] disabled:cursor-not-allowed disabled:opacity-55";
  const primaryButton = `${buttonClass} border-[var(--agui-accent)] bg-[var(--agui-accent)] text-black`;
  const dangerButton = `${buttonClass} border-[color-mix(in_srgb,#ff5c5c_70%,var(--agui-border))] bg-transparent text-[#ff7676]`;
  const labelClass = "flex flex-col gap-1 text-[var(--agui-muted)]";
  const fieldText = "text-[var(--agui-fg)]";

  return (
    <div className="flex flex-col gap-3">
      <section className="grid gap-2">
        <div className="font-semibold text-[var(--agui-fg)]">{t(language, "account")}</div>
        <label className={labelClass}>
          <span>{t(language, "email")}</span>
          <input
            className={inputClass}
            value={account.email}
            autoComplete="email"
            onChange={(event) =>
              patchAccount({
                email: event.target.value,
                username: account.username ? account.username : event.target.value,
              })
            }
          />
        </label>
        <label className={labelClass}>
          <span>{t(language, "username")}</span>
          <input
            className={inputClass}
            value={account.username}
            autoComplete="username"
            onChange={(event) => patchAccount({ username: event.target.value })}
          />
        </label>
        <label className={labelClass}>
          <span>{t(language, "displayName")}</span>
          <input
            className={inputClass}
            value={account.displayName}
            onChange={(event) => patchAccount({ displayName: event.target.value })}
          />
        </label>
        <label className={labelClass}>
          <span>{t(language, "appPassword")}</span>
          <input
            className={inputClass}
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder={passwordConfigured ? t(language, "keepPassword") : ""}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {passwordConfigured ? (
          <div className="flex items-center gap-1.5 text-[var(--agui-muted)]">
            <CheckCircle2 className="size-3.5 text-[color-mix(in_srgb,var(--agui-accent)_70%,white)]" />
            <span>{t(language, "passwordSaved")}</span>
          </div>
        ) : null}
      </section>

      <section className="grid gap-2">
        <div className="font-semibold text-[var(--agui-fg)]">{t(language, "incoming")}</div>
        <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
          <label className={labelClass}>
            <span>{t(language, "incomingHost")}</span>
            <input
              className={inputClass}
              value={account.incomingHost}
              placeholder="pop.example.com"
              onChange={(event) => patchAccount({ incomingHost: event.target.value })}
            />
          </label>
          <label className={labelClass}>
            <span>{t(language, "incomingPort")}</span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={65535}
              value={account.incomingPort}
              onChange={(event) =>
                patchAccount({ incomingPort: clamp(Number(event.target.value), 1, 65535) })
              }
            />
          </label>
        </div>
        <label className={labelClass}>
          <span>{t(language, "security")}</span>
          <select
            className={inputClass}
            value={account.incomingSecurity}
            onChange={(event) => {
              const security = securityValue(event.target.value);
              patchAccount({
                incomingPort: nextPortForSecurity(
                  "pop",
                  account.incomingPort,
                  account.incomingSecurity,
                  security,
                ),
                incomingSecurity: security,
              });
            }}
          >
            <option value="tls">{t(language, "tls")}</option>
            <option value="starttls">{t(language, "starttls")}</option>
            <option value="plain">{t(language, "plain")}</option>
          </select>
        </label>
      </section>

      <section className="grid gap-2">
        <div className="font-semibold text-[var(--agui-fg)]">{t(language, "outgoing")}</div>
        <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
          <label className={labelClass}>
            <span>{t(language, "outgoingHost")}</span>
            <input
              className={inputClass}
              value={account.outgoingHost}
              placeholder="smtp.example.com"
              onChange={(event) => patchAccount({ outgoingHost: event.target.value })}
            />
          </label>
          <label className={labelClass}>
            <span>{t(language, "outgoingPort")}</span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={65535}
              value={account.outgoingPort}
              onChange={(event) =>
                patchAccount({ outgoingPort: clamp(Number(event.target.value), 1, 65535) })
              }
            />
          </label>
        </div>
        <label className={labelClass}>
          <span>{t(language, "security")}</span>
          <select
            className={inputClass}
            value={account.outgoingSecurity}
            onChange={(event) => {
              const security = securityValue(event.target.value);
              patchAccount({
                outgoingPort: nextPortForSecurity(
                  "smtp",
                  account.outgoingPort,
                  account.outgoingSecurity,
                  security,
                ),
                outgoingSecurity: security,
              });
            }}
          >
            <option value="tls">{t(language, "tls")}</option>
            <option value="starttls">{t(language, "starttls")}</option>
            <option value="plain">{t(language, "plain")}</option>
          </select>
        </label>
      </section>

      <section className="grid gap-2">
        <div className="grid grid-cols-2 gap-2">
          <label className={labelClass}>
            <span>{t(language, "messagesPerPage")}</span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={50}
              value={messagesPerPage}
              onChange={(event) => setMessagesPerPage(clamp(Number(event.target.value), 1, 50))}
            />
          </label>
          <label className={labelClass}>
            <span>{t(language, "previewLines")}</span>
            <input
              className={inputClass}
              type="number"
              min={0}
              max={80}
              value={previewLines}
              onChange={(event) => setPreviewLines(clamp(Number(event.target.value), 0, 80))}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-[var(--agui-muted)]">
          <input
            type="checkbox"
            checked={account.rejectUnauthorized}
            onChange={(event) => patchAccount({ rejectUnauthorized: event.target.checked })}
          />
          <span className={fieldText}>{t(language, "rejectUnauthorized")}</span>
        </label>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void save()}>
          <Save className="size-3.5" aria-hidden="true" />
          {t(language, "save")}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void testConnection()}
        >
          <PlugZap className="size-3.5" aria-hidden="true" />
          {t(language, "test")}
        </button>
        <button
          type="button"
          className={dangerButton}
          disabled={busy}
          onClick={() => void disconnect()}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          {t(language, "clear")}
        </button>
      </div>

      {message ? (
        <div
          className={`rounded-[7px] border px-2.5 py-2 ${
            messageTone === "error"
              ? "border-[color-mix(in_srgb,#ff5c5c_70%,var(--agui-border))] text-[#ff9b9b]"
              : "border-[color-mix(in_srgb,var(--agui-accent)_60%,var(--agui-border))] text-[var(--agui-fg)]"
          }`}
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}

function accountFrom(value: unknown): Account {
  const record = recordValue(value);
  const incomingSecurity = securityValue(record.incomingSecurity);
  const outgoingSecurity = securityValue(record.outgoingSecurity);
  return {
    displayName: stringValue(record.displayName),
    email: stringValue(record.email),
    incomingHost: stringValue(record.incomingHost),
    incomingPort: clamp(
      numberValue(record.incomingPort, defaultPopPort(incomingSecurity)),
      1,
      65535,
    ),
    incomingSecurity,
    outgoingHost: stringValue(record.outgoingHost),
    outgoingPort: clamp(
      numberValue(record.outgoingPort, defaultSmtpPort(outgoingSecurity)),
      1,
      65535,
    ),
    outgoingSecurity,
    rejectUnauthorized: boolValue(record.rejectUnauthorized, true),
    username: stringValue(record.username) || stringValue(record.email),
  };
}

function accountForStorage(account: Account): Record<string, unknown> {
  return {
    displayName: account.displayName.trim(),
    email: account.email.trim(),
    incomingHost: account.incomingHost.trim(),
    incomingPort: clamp(account.incomingPort, 1, 65535),
    incomingSecurity: account.incomingSecurity,
    outgoingHost: account.outgoingHost.trim(),
    outgoingPort: clamp(account.outgoingPort, 1, 65535),
    outgoingSecurity: account.outgoingSecurity,
    rejectUnauthorized: account.rejectUnauthorized,
    username: account.username.trim() || account.email.trim(),
  };
}

function securityValue(value: unknown): Security {
  return value === "plain" || value === "starttls" || value === "tls" ? value : "tls";
}

function defaultPopPort(security: Security): number {
  return security === "tls" ? 995 : 110;
}

function defaultSmtpPort(security: Security): number {
  if (security === "tls") return 465;
  if (security === "starttls") return 587;
  return 25;
}

function nextPortForSecurity(
  protocol: "pop" | "smtp",
  currentPort: number,
  currentSecurity: Security,
  nextSecurity: Security,
): number {
  const defaultFor = protocol === "pop" ? defaultPopPort : defaultSmtpPort;
  const currentDefault = defaultFor(currentSecurity);
  const nextDefault = defaultFor(nextSecurity);
  return currentPort === currentDefault ? nextDefault : currentPort || nextDefault;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

mount(<Configuration />);
