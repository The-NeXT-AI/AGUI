import type {
  ExtensionChatRendererContribution,
  ExtensionFloatingWidgetContribution,
  ExtensionToolbarControlContribution,
  ExtensionViewContribution as ExtensionManifestViewContribution,
} from "@/asp/desktop-api";
import { ShieldAlert } from "lucide-react";
import { ExtensionSlot } from "./ExtensionSlot";
import { useExtensionStore } from "./extension-store";
import type { ExtensionRenderSurface } from "./extension-broker";

type ExtensionViewContribution = (
  | ExtensionToolbarControlContribution
  | ExtensionFloatingWidgetContribution
  | ExtensionChatRendererContribution
  | ExtensionManifestViewContribution
) & { activationEvent?: string };

export function ExtensionView({
  extensionId,
  contribution,
  data,
  executeCommand,
  surface,
  className,
}: {
  extensionId: string;
  contribution: ExtensionViewContribution;
  data?: unknown;
  executeCommand?: (command: string, args: unknown[]) => unknown | Promise<unknown>;
  surface: ExtensionRenderSurface;
  allowNetwork?: boolean;
  className?: string;
}) {
  const record = useExtensionStore((state) =>
    state.records.find((candidate) => candidate.id === extensionId),
  );
  if (!record) return <ExtensionViewError message={`Extension is not available: ${extensionId}`} />;
  return (
    <ExtensionSlot
      record={record}
      contribution={contribution}
      data={data}
      executeCommand={executeCommand}
      surface={surface}
      className={className}
    />
  );
}

function ExtensionViewError({ message }: { message: string }) {
  return (
    <div className="border-danger/30 bg-danger/5 text-danger flex min-h-24 items-start gap-2 rounded-md border p-3 text-[12px]">
      <ShieldAlert size={15} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
