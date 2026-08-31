import assert from "node:assert/strict";

import {
  ScheduledTaskService,
  countMissedScheduledRuns,
  scheduledRetryDelayMs,
} from "../packages/runtime/src/scheduled-tasks.ts";

function memoryStorage() {
  const values = new Map();
  const keyFor = ({ key, namespace = "default" }) => `${namespace}:${key}`;
  return {
    async get(input) {
      return values.get(keyFor(input)) ?? null;
    },
    async set(input) {
      values.set(keyFor(input), String(input.value));
    },
    async remove(input) {
      values.delete(keyFor(input));
    },
  };
}

async function waitUntil(predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

assert.equal(scheduledRetryDelayMs({ backoffMinutes: 5, maxRetries: 3 }, 2), 10 * 60_000);
assert.equal(
  countMissedScheduledRuns({ type: "interval", intervalMinutes: 5 }, 1_000, 16 * 60_000 + 1_000),
  3,
);

const broadcasts = [];
let runCalls = 0;
const service = new ScheduledTaskService({
  broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  defaultWorkspace: () => "/tmp/agui-default-workspace",
  privateSessionDirectory: (sessionId) => `/tmp/${sessionId}`,
  run: async () => {
    runCalls += 1;
    return {
      canceled: false,
      providerSessionId: `provider-session-${runCalls}`,
      success: runCalls > 1,
    };
  },
  storage: memoryStorage(),
});

const task = await service.addTask({
  approvalMode: "auto-edit",
  enabled: true,
  projectPath: null,
  prompt: "Run the reliability probe",
  providerId: "codex",
  retryPolicy: { backoffMinutes: 1, maxRetries: 1 },
  schedule: { type: "interval", intervalMinutes: 60 },
  title: "Reliability probe",
  workspaceId: "test-workspace",
});

service.tasks = service.tasks.map((item) =>
  item.id === task.id ? { ...item, nextRunAt: Date.now() - 60_000 } : item,
);
await service.tick();
await waitUntil(() => runCalls === 1 && service.tasks[0]?.lastRunStatus === "failed", "first run");

let persisted = service.tasks[0];
assert.equal(persisted.pendingRetry?.attempt, 1);
assert.equal(persisted.runHistory[0]?.status, "failed");
assert.equal(persisted.failureCount, 1);
assert.equal(persisted.missedRunCount, 0);

service.tasks = service.tasks.map((item) =>
  item.id === task.id ? { ...item, nextRunAt: Date.now() - 1 } : item,
);
await service.tick();
await waitUntil(() => runCalls === 2 && service.tasks[0]?.lastRunStatus === "success", "retry run");

persisted = service.tasks[0];
assert.equal(persisted.pendingRetry, undefined);
assert.equal(persisted.failureCount, 0);
assert.equal(persisted.runHistory[0]?.reason, "retry");
assert.equal(persisted.runHistory[0]?.status, "success");
assert.equal(persisted.runHistory[1]?.status, "failed");
assert.ok(
  broadcasts.some(
    (event) => event.channel === "agui:schedule:event" && event.payload.type === "run_started",
  ),
);

service.stop();
