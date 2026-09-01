import type {
  AppExtensionPermission,
  ExtensionAuditListInput,
  ExtensionMarketplaceListInput,
  ExtensionRuntimeEvent,
} from "@the-next-ai/extensions";
import type { RuntimeMethodHandler } from "@the-next-ai/runtime";
import { ServerExtensionService } from "./server-extension-service.js";

export function createServerExtensionRuntime(options: {
  defaultWorkspace?: string | (() => string);
  emit: (event: ExtensionRuntimeEvent) => void;
  homeDir?: string | (() => string);
}): {
  extensionMethod: RuntimeMethodHandler;
  extensionService: ServerExtensionService;
} {
  const extensionService = new ServerExtensionService({
    defaultWorkspace: options.defaultWorkspace,
    emit: options.emit,
    homeDir: options.homeDir,
  });
  let extensionMethodQueue: Promise<void> = Promise.resolve();
  return {
    extensionService,
    extensionMethod: (method, params) => {
      const pending = extensionMethodQueue.then(() =>
        invokeServerExtensionMethod(extensionService, method, params),
      );
      extensionMethodQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}

async function invokeServerExtensionMethod(
  extensionService: ServerExtensionService,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case "extensions.list": {
      const input = params as
        { workspacePath?: string; workspaceId?: string; extensionIds?: string[] } | undefined;
      return extensionService.list(
        String(input?.workspacePath ?? ""),
        String(input?.workspaceId ?? ""),
        input?.extensionIds,
      );
    }
    case "extensions.audit": {
      return extensionService.audit((params as ExtensionAuditListInput | undefined) ?? {});
    }
    case "extensions.marketplace": {
      return extensionService.marketplace(
        (params as ExtensionMarketplaceListInput | undefined) ?? {},
      );
    }
    case "extensions.chooseInstall":
      throw new Error("Choose an extension package directory from the server file picker.");
    case "extensions.chooseUpdate":
      throw new Error("Choose an extension package from the server file picker.");
    case "extensions.install": {
      const input = params as {
        expectedSha256?: string;
        sourcePath?: string;
        sourceUrl?: string;
        updateUrl?: string;
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.install(
        String(input?.sourcePath ?? ""),
        input?.workspaceId,
        input?.workspacePath,
        {
          expectedSha256: input?.expectedSha256,
          sourceUrl: input?.sourceUrl,
          updateUrl: input?.updateUrl,
        },
      );
    }
    case "extensions.update": {
      const input = params as {
        extensionId?: string;
        expectedSha256?: string;
        sourcePath?: string;
        sourceUrl?: string;
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.update(
        String(input?.extensionId ?? ""),
        {
          expectedSha256: input?.expectedSha256,
          sourcePath: input?.sourcePath,
          sourceUrl: input?.sourceUrl,
        },
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.uninstall": {
      const input = params as
        { extensionId?: string; workspacePath?: string; workspaceId?: string } | string;
      return typeof input === "string"
        ? extensionService.uninstall(input)
        : extensionService.uninstall(
            String(input?.extensionId ?? ""),
            input?.workspaceId,
            input?.workspacePath,
          );
    }
    case "extensions.setEnabled": {
      const input = params as {
        extensionId?: string;
        enabled?: boolean;
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.setEnabled(
        String(input?.extensionId ?? ""),
        Boolean(input?.enabled),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.grant": {
      const input = params as {
        extensionId?: string;
        permissions?: AppExtensionPermission[];
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.grant(
        String(input?.extensionId ?? ""),
        input?.permissions ?? [],
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.setWorkspaceTrust": {
      const input = params as {
        workspacePath?: string;
        workspaceId?: string;
        trusted?: boolean;
      };
      return extensionService.setWorkspaceTrust(
        String(input?.workspacePath ?? ""),
        Boolean(input?.trusted),
        input?.workspaceId,
      );
    }
    case "extensions.workspaceTrusted": {
      const input = params as { workspacePath?: string };
      return extensionService.isWorkspaceTrusted(String(input?.workspacePath ?? ""));
    }
    case "extensions.readAsset": {
      const input = params as {
        extensionId?: string;
        path?: string;
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.readAsset(
        String(input?.extensionId ?? ""),
        String(input?.path ?? ""),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.activate": {
      const input = params as {
        extensionId?: string;
        event?: string;
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.activate(
        String(input?.extensionId ?? ""),
        String(input?.event ?? ""),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.executeCommand": {
      const input = params as {
        extensionId?: string;
        command?: string;
        args?: unknown[];
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.executeCommand(
        String(input?.extensionId ?? ""),
        String(input?.command ?? ""),
        Array.isArray(input?.args) ? input.args : [],
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.resolveAgent": {
      const input = params as {
        workspacePath?: string;
        workspaceId?: string;
        extensionIds?: string[];
      };
      return extensionService.resolveAgentContributions(
        String(input?.workspacePath ?? ""),
        String(input?.workspaceId ?? ""),
        input?.extensionIds,
      );
    }
    case "extensions.getConfiguration": {
      const input = params as {
        extensionId?: string;
        workspacePath?: string;
        workspaceId?: string;
      };
      return extensionService.getConfiguration(
        String(input?.extensionId ?? ""),
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    case "extensions.updateConfiguration": {
      const input = params as {
        extensionId?: string;
        workspacePath?: string;
        workspaceId?: string;
        values?: unknown;
      };
      return extensionService.updateConfiguration(
        String(input?.extensionId ?? ""),
        input?.values && typeof input.values === "object" && !Array.isArray(input.values)
          ? (input.values as Record<string, unknown>)
          : {},
        input?.workspaceId,
        input?.workspacePath,
      );
    }
    default:
      throw new Error(`Unknown extension runtime method: ${method}`);
  }
}
