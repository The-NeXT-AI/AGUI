import "./styles.css";

import { useEffect, useState } from "react";
import { Mail, PlugZap, RefreshCw } from "lucide-react";
import { aguiCommand, mailLanguage, recordValue, stringValue, useAguiData } from "./common";
import { mount } from "./mount";

type Language = "en" | "zh";

const text = {
  en: {
    account: "Account",
    configured: "Configured",
    incoming: "Incoming",
    notConfigured: "Not configured",
    outgoing: "Outgoing",
    password: "Password",
    refresh: "Refresh",
    saved: "saved",
    test: "Test",
  },
  zh: {
    account: "账号",
    configured: "已配置",
    incoming: "收件",
    notConfigured: "未配置",
    outgoing: "发件",
    password: "密码",
    refresh: "刷新",
    saved: "已保存",
    test: "测试",
  },
} as const;

function t(language: Language, key: keyof typeof text.en): string {
  return text[language][key] || text.en[key] || key;
}

function Panel() {
  const data = useAguiData();
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState<Language>("en");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"" | "error" | "success">("");
  const [state, setState] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const nextLanguage = mailLanguage(recordValue(data).language);
    setLanguage(nextLanguage);
    document.documentElement.lang = nextLanguage;
    void load(nextLanguage);
  }, [data]);

  async function load(nextLanguage = language) {
    setBusy(true);
    setMessage("");
    try {
      setState(recordValue(await aguiCommand("agui.mail.panelData", [{ language: nextLanguage }])));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage("");
    try {
      const result = recordValue(await aguiCommand("agui.mail.testConnection", [{ language }]));
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

  const account = recordValue(state.account);
  const configured = state.configured === true;
  const title =
    stringValue(account.displayName) ||
    stringValue(account.email) ||
    stringValue(account.username) ||
    t(language, "notConfigured");
  const buttonClass =
    "inline-flex size-7 cursor-pointer items-center justify-center rounded-[7px] border border-[var(--agui-border)] bg-[color-mix(in_srgb,var(--agui-surface)_90%,white)] text-[var(--agui-fg)] disabled:cursor-not-allowed disabled:opacity-55";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--agui-border)_70%,transparent)] px-3 py-2.5">
        <Mail className="size-4 shrink-0 text-[var(--agui-accent)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] font-bold">{title}</strong>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--agui-muted)]">
            {configured ? t(language, "configured") : t(language, "notConfigured")}
          </span>
        </div>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void test()}
          title={t(language, "test")}
          aria-label={t(language, "test")}
        >
          <PlugZap className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void load()}
          title={t(language, "refresh")}
          aria-label={t(language, "refresh")}
        >
          <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-3">
        <div className="grid gap-2">
          <StatusRow label={t(language, "account")} value={stringValue(account.email) || "-"} />
          <StatusRow label={t(language, "incoming")} value={stringValue(state.incoming) || "-"} />
          <StatusRow label={t(language, "outgoing")} value={stringValue(state.outgoing) || "-"} />
          <StatusRow
            label={t(language, "password")}
            value={state.passwordConfigured === true ? t(language, "saved") : "-"}
          />
        </div>
        {message ? (
          <div
            className={`mt-3 rounded-[7px] border px-2.5 py-2 ${
              messageTone === "error"
                ? "border-[color-mix(in_srgb,#ff5c5c_70%,var(--agui-border))] text-[#ff9b9b]"
                : "border-[color-mix(in_srgb,var(--agui-accent)_60%,var(--agui-border))] text-[var(--agui-fg)]"
            }`}
          >
            {message}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2 rounded-[7px] border border-[color-mix(in_srgb,var(--agui-border)_70%,transparent)] bg-[color-mix(in_srgb,var(--agui-surface)_86%,transparent)] px-2.5 py-2">
      <span className="text-[var(--agui-muted)]">{label}</span>
      <span className="min-w-0 truncate text-[var(--agui-fg)]">{value}</span>
    </div>
  );
}

mount(<Panel />);
