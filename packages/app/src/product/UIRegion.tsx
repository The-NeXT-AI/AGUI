import type { ReactNode } from "react";
import { useRegistryStore } from "@the-next-ai/app";
import { DeclarativeExtensionView } from "@/extensions/DeclarativeExtensionView";
import { ExtensionWebComponent } from "@/extensions/ExtensionWebComponent";
import { cn } from "@/ui/cn";
import { useProductConfig, type ProductUIRenderable } from "./product-config";

export function UIRegion({
  id,
  children,
  className,
  data,
  allowNetwork = false,
}: {
  id: string;
  children?: ReactNode;
  className?: string;
  data?: unknown;
  allowNetwork?: boolean;
}) {
  const productConfig = useProductConfig();
  const region = productConfig.ui.regions[id];
  if (region?.hidden) return null;

  const regionData = {
    ...objectData(data),
    data,
    product: productConfig.app,
    region: {
      id,
      data: region?.data ?? {},
    },
  };
  const regionAllowsNetwork = allowNetwork || region?.allowNetwork === true;
  const replacement = region?.replace
    ? renderRegionContent(id, "replace", region.replace, regionData, regionAllowsNetwork)
    : children;

  return (
    <div
      data-ui-region={id}
      data-ui-region-customized={region ? "true" : undefined}
      data-ui-region-replaced={region?.replace ? "true" : undefined}
      className={cn("contents", className, region?.className)}
    >
      {region?.before
        ? renderRegionContent(id, "before", region.before, regionData, regionAllowsNetwork)
        : null}
      {replacement}
      {region?.after
        ? renderRegionContent(id, "after", region.after, regionData, regionAllowsNetwork)
        : null}
    </div>
  );
}

function renderRegionContent(
  regionId: string,
  position: "before" | "after" | "replace",
  content: ProductUIRenderable,
  data: unknown,
  allowNetwork: boolean,
): ReactNode {
  const nodes = Array.isArray(content) ? content : [content];
  return nodes.map((node, index) =>
    node.renderMode === "declarative" ? (
      <DeclarativeExtensionView
        key={`${position}:declarative:${index}`}
        extensionId={`product:${regionId}`}
        schema={node.schema}
        data={data}
        allowNetwork={allowNetwork || node.allowNetwork === true}
        className="block w-full"
        executeCommand={executeAppCommand}
      />
    ) : (
      <ExtensionWebComponent
        key={`${position}:component:${index}`}
        extensionId={`product:${regionId}`}
        html={node.html}
        data={data}
        allowNetwork={allowNetwork || node.allowNetwork === true}
        compact={false}
        className="block w-full"
        executeCommand={executeAppCommand}
      />
    ),
  );
}

function executeAppCommand(commandId: string, args: unknown[]): unknown | Promise<unknown> {
  const command = useRegistryStore.getState().commands[commandId];
  if (!command) throw new Error(`Unknown app command: ${commandId}`);
  return command.handler(...args);
}

function objectData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
