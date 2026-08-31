import { useEffect, useMemo, useState } from "react";
import type { AppExtensionRecord } from "@/asp/desktop-api";
import { Loader2, ShieldAlert } from "lucide-react";
import { DeclarativeExtensionView, parseDeclarativeSchema } from "./DeclarativeExtensionView";
import { ExtensionSandboxedWebview } from "./ExtensionSandboxedWebview";
import { ExtensionWebComponent } from "./ExtensionWebComponent";
import { backendExtensionHost } from "./extension-backend-host";
import {
  extensionRenderPlan,
  type ExtensionRenderSurface,
  type ExtensionSlotContribution,
} from "./extension-broker";

export function ExtensionSlot({
  record,
  contribution,
  data,
  surface,
  compact,
  className,
  executeCommand,
}: {
  record: AppExtensionRecord;
  contribution: ExtensionSlotContribution;
  data?: unknown;
  surface: ExtensionRenderSurface;
  compact?: boolean;
  className?: string;
  executeCommand?: (command: string, args: unknown[]) => unknown | Promise<unknown>;
}) {
  const [asset, setAsset] = useState<string | null>(null);
  const [error, setError] = useState("");
  const entry = typeof contribution.entry === "string" ? contribution.entry : "";
  const plan = useMemo(
    () => extensionRenderPlan(record, contribution, surface),
    [contribution, record, surface],
  );
  const compactSurface = compact ?? (surface === "composer" || surface === "header");

  useEffect(() => {
    let canceled = false;
    setError("");
    setAsset(null);
    if (!plan.allowed) return undefined;

    if (shouldActivateSlot(record)) {
      void backendExtensionHost.activate(record.id, plan.activationEvent).catch((cause) => {
        console.warn(
          `Extension activation failed for ${record.id}:${plan.activationEvent}`,
          cause instanceof Error ? cause.message : cause,
        );
      });
    }

    void (async () => {
      if (!entry) return "";
      const result = await backendExtensionHost.readAsset(record.id, entry);
      if (result.encoding !== "utf8") {
        throw new Error("Extension view entry must be a text asset.");
      }
      return result.data;
    })()
      .then((content) => {
        if (!canceled) setAsset(content);
      })
      .catch((cause) => {
        if (!canceled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      canceled = true;
    };
  }, [
    entry,
    plan.activationEvent,
    plan.allowed,
    record,
    record.extensionPath,
    record.id,
    record.manifest.main,
    record.source,
    record.workspaceTrusted,
  ]);

  if (!plan.allowed) return <ExtensionSlotError message={plan.reason ?? "Extension UI denied."} />;
  if (error) return <ExtensionSlotError message={error} />;
  if (entry && asset == null) {
    if (extensionLoadingIndicator(contribution) === "hidden") return null;
    if (compactSurface) {
      return (
        <div className="text-subtle flex h-8 w-8 shrink-0 items-center justify-center">
          <Loader2 size={16} className="animate-spin" />
        </div>
      );
    }
    return (
      <div className="text-subtle flex h-full min-h-24 items-center justify-center">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  const content = renderSlotContent({
    asset: asset ?? "",
    className,
    compact: compactSurface,
    data,
    executeCommand,
    plan,
    record,
  });
  return (
    <div
      data-extension-slot={contribution.id}
      data-extension-id={record.id}
      data-extension-render-mode={plan.mode}
      data-extension-isolation={plan.isolation}
      className="contents"
    >
      {content}
    </div>
  );
}

function shouldActivateSlot(record: AppExtensionRecord): boolean {
  if (!record.manifest.main) return false;
  if (record.source === "workspace" && !record.workspaceTrusted) return false;
  return true;
}

function extensionLoadingIndicator(contribution: ExtensionSlotContribution): "visible" | "hidden" {
  return (contribution as { loadingIndicator?: unknown }).loadingIndicator === "hidden"
    ? "hidden"
    : "visible";
}

function renderSlotContent({
  asset,
  className,
  compact,
  data,
  executeCommand,
  plan,
  record,
}: {
  asset: string;
  className?: string;
  compact: boolean;
  data?: unknown;
  executeCommand?: (command: string, args: unknown[]) => unknown | Promise<unknown>;
  plan: ReturnType<typeof extensionRenderPlan>;
  record: AppExtensionRecord;
}) {
  if (plan.mode === "declarative") {
    try {
      return (
        <DeclarativeExtensionView
          extensionId={record.id}
          schema={parseDeclarativeSchema(asset)}
          data={data}
          allowNetwork={plan.allowNetwork}
          compact={compact}
          className={className}
          executeCommand={executeCommand}
        />
      );
    } catch (cause) {
      return (
        <ExtensionSlotError
          message={`Invalid declarative extension UI: ${
            cause instanceof Error ? cause.message : String(cause)
          }`}
        />
      );
    }
  }
  if (plan.mode === "webview") {
    return (
      <ExtensionSandboxedWebview
        extensionId={record.id}
        html={asset}
        data={data}
        allowNetwork={plan.allowNetwork}
        compact={compact}
      />
    );
  }
  return (
    <ExtensionWebComponent
      extensionId={record.id}
      html={asset}
      data={data}
      allowNetwork={plan.allowNetwork}
      compact={compact}
      executeCommand={executeCommand}
      className={className}
    />
  );
}

function ExtensionSlotError({ message }: { message: string }) {
  return (
    <div className="border-danger/30 bg-danger/5 text-danger flex min-h-24 items-start gap-2 rounded-md border p-3 text-[12px]">
      <ShieldAlert size={15} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
