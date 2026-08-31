import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/ui/cn";
import type { AspProvider } from "@/asp/desktop-api";
import claudeCodeLogo from "@/assets/agent-logos/claude-code.png";
import codexLogo from "@/assets/agent-logos/codex.png";
import grokLogo from "@/assets/agent-logos/grok.ico";
import kimiLogo from "@/assets/agent-logos/kimi.ico";
import kiloLogo from "@/assets/agent-logos/kilo.svg";
import opencodeLogo from "@/assets/agent-logos/opencode.ico";
import piLogo from "@/assets/agent-logos/pi.svg";

type AgentLogoMeta = {
  className: string;
  fallback?: "claude";
  icon?: string;
};

export function AgentLogo({
  provider,
  compact = false,
  className,
}: {
  provider?: AspProvider;
  compact?: boolean;
  className?: string;
}) {
  const meta = agentLogoMeta(provider);
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const icon = meta.icon && meta.icon !== failedIcon ? meta.icon : undefined;
  const sizeClass = compact ? "h-5 w-5 text-[9px]" : "h-6 w-6 text-[10px]";

  useEffect(() => {
    setFailedIcon(null);
  }, [meta.icon]);

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full leading-none font-semibold",
        sizeClass,
        meta.className,
        className,
      )}
      aria-label={provider?.name ?? "Agent"}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => setFailedIcon(icon)}
        />
      ) : (
        <AgentLogoFallback meta={meta} compact={compact} />
      )}
    </span>
  );
}

function AgentLogoFallback({ meta, compact }: { meta: AgentLogoMeta; compact: boolean }) {
  if (meta.fallback === "claude") {
    return (
      <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden="true">
        <rect width="24" height="24" rx="12" fill="#df714f" />
        <g stroke="white" strokeLinecap="round" strokeWidth="2.15">
          <path d="M12 4.3v15.4" />
          <path d="M4.8 12h14.4" />
          <path d="M6.9 6.9l10.2 10.2" />
          <path d="M17.1 6.9 6.9 17.1" />
          <path d="M9.2 4.9 14.8 19.1" />
          <path d="M19.1 9.2 4.9 14.8" />
          <path d="M14.8 4.9 9.2 19.1" />
          <path d="M4.9 9.2 19.1 14.8" />
        </g>
      </svg>
    );
  }
  return <Bot size={compact ? 13 : 14} strokeWidth={2} aria-hidden="true" />;
}

function agentLogoMeta(provider?: AspProvider): AgentLogoMeta {
  const key = `${provider?.id ?? ""} ${provider?.name ?? ""}`.toLowerCase();
  if (!provider) {
    return { className: "border border-border-strong bg-surface text-subtle" };
  }
  if (key.includes("claude")) {
    return { icon: claudeCodeLogo, fallback: "claude", className: "bg-white text-orange-300" };
  }
  if (key.includes("grok")) {
    return { icon: grokLogo, className: "bg-black text-fg" };
  }
  if (key.includes("opencode") || key.includes("open code")) {
    return { icon: opencodeLogo, className: "bg-white text-info" };
  }
  if (key.includes("kimi")) {
    return { icon: kimiLogo, className: "bg-white text-blue-300" };
  }
  if (key.includes("pi")) {
    return { icon: piLogo, className: "bg-white text-emerald-300" };
  }
  if (key.includes("kilo")) {
    return { icon: kiloLogo, className: "bg-white text-violet-300" };
  }
  if (key.includes("codex") || key.includes("openai")) {
    return { icon: codexLogo, className: "bg-white text-accent" };
  }
  return { className: "border border-border-strong bg-surface text-muted" };
}
