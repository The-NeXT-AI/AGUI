import { parentPort, workerData } from "node:worker_threads";
import { AspManager } from "@agui/asp/manager";
import type { AspProvider } from "@agui/asp/types";
import { projectTranscriptSession } from "./transcript-projection.js";

type TranscriptHydrationWorkerInput = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  previousContextUsage?: {
    used: number;
    usedKnown?: boolean;
    size: number;
    source?: string;
    cost?: { amount: number; currency: string } | null;
  };
  providerId: string;
  providerSessionId: string;
  providers?: AspProvider[];
  transcriptPath?: string;
  userDataPath: string;
};

void hydrateTranscript(workerData as TranscriptHydrationWorkerInput);

async function hydrateTranscript(input: TranscriptHydrationWorkerInput): Promise<void> {
  const manager = new AspManager({
    providerStoreOptions: {
      env: input.env,
      userDataPath: input.userDataPath,
    },
  });
  try {
    const lookupSessionId = input.transcriptPath || input.providerSessionId;
    let result = await manager.resumeSession(input.providerId, lookupSessionId, input.cwd);
    if (!result.messages.length) {
      result = {
        ...result,
        messages: await manager.sessionMessages(input.providerId, lookupSessionId),
      };
    }
    const projection = projectTranscriptSession({
      messages: result.messages,
      previousContextUsage: input.previousContextUsage,
      providerId: input.providerId,
      providers: input.providers ?? [],
      session: result.session,
    });
    parentPort?.postMessage({ ok: true, projection });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: serializeError(error) });
  } finally {
    await manager.dispose();
  }
}

function serializeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error) };
}
