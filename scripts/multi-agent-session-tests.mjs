import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_HANDOFF_MAX_BLOCKS,
  AGENT_HANDOFF_MAX_CHARS,
  buildAgentConversationContext,
  selectAgentHandoff,
} from "../packages/app/src/chat/agent-handoff.ts";
import {
  normalizeAgentOrchestration,
  projectAgentLifecycle,
  providerParticipantId,
  targetPromptForSession,
} from "../packages/app/src/chat/agent-orchestration.ts";
import { providerIdForSessionEvent } from "../packages/app/src/chat/agent-routing.ts";
import {
  cleanupHandoffFiles,
  createHandoffFileMcpToolProvider,
  prepareHandoffFiles,
} from "../packages/runtime/src/mcp-gateway/handoff-file-tool-provider.ts";

function session(overrides = {}) {
  return {
    id: "session",
    title: "Shared session",
    blocks: [],
    status: "idle",
    connectionState: "disconnected",
    providerId: "codex",
    cwd: "/tmp/project",
    createdAt: 1,
    ...overrides,
  };
}

{
  const active = session({
    providerId: "claude",
    activeRunId: "run-new",
    activeRunProviderId: "claude",
  });
  assert.equal(
    providerIdForSessionEvent(active, { id: "e1", type: "assistant_delta", text: "ok" }),
    "claude",
  );
  assert.equal(
    providerIdForSessionEvent(active, {
      id: "e2",
      type: "assistant_delta",
      text: "late",
      runId: "run-old",
      agentProviderId: "codex",
    }),
    null,
  );
  assert.equal(
    providerIdForSessionEvent(active, {
      id: "e3",
      type: "assistant_delta",
      text: "current",
      runId: "run-new",
      agentProviderId: "claude",
    }),
    "claude",
  );
  assert.equal(
    providerIdForSessionEvent(session({ providerId: "claude" }), {
      id: "e4",
      type: "assistant_delta",
      text: "finished run",
      runId: "run-old",
      agentProviderId: "claude",
    }),
    null,
  );
}

{
  const shared = session({
    providerId: "claude",
    blocks: [
      {
        id: "u1",
        kind: "user",
        text: "Inspect this file",
        attachments: [
          {
            id: "a1",
            kind: "file",
            name: "report.txt",
            path: "/tmp/project/report.txt",
            mime: "text/plain",
            size: 42,
          },
        ],
        createdAt: 1,
      },
      {
        id: "a1",
        kind: "assistant",
        text: "The report is valid.",
        agentProviderId: "codex",
        createdAt: 2,
      },
      { id: "u2", kind: "user", text: "Now summarize it", createdAt: 3 },
    ],
    agentSessions: {
      claude: { status: "never_used" },
    },
  });
  const handoff = selectAgentHandoff(shared, "claude", {
    excludeLastUser: true,
    providerNames: new Map([["codex", "Codex"]]),
  });
  assert.ok(handoff);
  assert.deepEqual(JSON.parse(handoff.serialized).messages, handoff.entries);
  assert.equal(handoff.sourceSeq, 0);
  assert.equal(handoff.highWatermarkSeq, 2);
  assert.deepEqual(handoff.entries, [
    {
      id: "u1",
      seq: 1,
      role: "user",
      content: "Inspect this file",
      attachments: [
        {
          kind: "file",
          mimeType: "text/plain",
          name: "report.txt",
          path: "/tmp/project/report.txt",
          size: 42,
        },
      ],
    },
    {
      id: "a1",
      seq: 2,
      role: "assistant",
      agent: "Codex",
      participantId: "provider:codex",
      content: "The report is valid.",
    },
  ]);
  assert.deepEqual(handoff.files, [
    {
      id: "attachment:a1",
      name: "report.txt",
      mimeType: "text/plain",
      size: 42,
      sourceBlockId: "u1",
      sourcePath: "/tmp/project/report.txt",
      uri: "agui-handoff://file/attachment%3Aa1",
      availability: "pending",
    },
  ]);
}

{
  const blocks = Array.from({ length: AGENT_HANDOFF_MAX_BLOCKS + 8 }, (_, index) => ({
    id: `u${index}`,
    kind: "user",
    text: `message-${index}`,
    createdAt: index,
  }));
  const handoff = selectAgentHandoff(
    session({ providerId: "claude", blocks, agentSessions: { claude: { status: "never_used" } } }),
    "claude",
    { excludeLastUser: false },
  );
  assert.ok(handoff);
  assert.equal(handoff.entries.length, AGENT_HANDOFF_MAX_BLOCKS);
  assert.equal(handoff.entries[0].content, "message-8");
  assert.equal(handoff.truncated, true);
}

{
  const handoff = selectAgentHandoff(
    session({
      providerId: "claude",
      blocks: [{ id: "u1", kind: "user", text: "x".repeat(20_000), createdAt: 1 }],
      agentSessions: { claude: { status: "never_used" } },
    }),
    "claude",
    { excludeLastUser: false },
  );
  assert.ok(handoff);
  assert.equal(handoff.truncated, true);
  assert.ok(handoff.serialized.length <= AGENT_HANDOFF_MAX_CHARS);
  assert.equal(handoff.entries[0].truncated, true);
}

{
  const blocks = [
    { id: "u1", kind: "user", text: "original task", conversationSeq: 1 },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      kind: "tool",
      title: `tool ${index}`,
      output: "ok",
      status: "success",
      conversationSeq: index + 2,
    })),
    {
      id: "a1",
      kind: "assistant",
      text: "final answer",
      streaming: false,
      agentProviderId: "codex",
      conversationSeq: 22,
    },
    { id: "u2", kind: "user", text: "review", conversationSeq: 23 },
  ];
  const handoff = selectAgentHandoff(
    session({ providerId: "claude", blocks, agentSessions: { claude: { status: "never_used" } } }),
    "claude",
    { excludeLastUser: true },
  );
  assert.ok(handoff);
  assert.deepEqual(
    handoff.entries.map((entry) => entry.id),
    ["u1", "a1"],
  );
  assert.equal(handoff.artifacts.at(-1)?.id, "t19");
  assert.equal(handoff.truncated, true);
}

{
  const blocks = [
    { id: "u1", kind: "user", text: "U".repeat(5_000), conversationSeq: 1 },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `t${index}`,
      kind: "tool",
      title: `tool ${index}`,
      output: "T".repeat(1_600),
      status: "success",
      conversationSeq: index + 2,
    })),
    {
      id: "a1",
      kind: "assistant",
      text: "FINAL".repeat(1_000),
      streaming: false,
      agentProviderId: "codex",
      conversationSeq: 7,
    },
    { id: "u2", kind: "user", text: "review", conversationSeq: 8 },
  ];
  const handoff = selectAgentHandoff(
    session({ providerId: "claude", blocks, agentSessions: { claude: { status: "never_used" } } }),
    "claude",
    { excludeLastUser: true },
  );
  assert.ok(handoff);
  assert.deepEqual(
    handoff.entries.map((entry) => entry.id),
    ["u1", "a1"],
  );
  assert.ok(handoff.serialized.length <= AGENT_HANDOFF_MAX_CHARS);
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agui-handoff-test-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    const userData = path.join(tempRoot, "data");
    fs.mkdirSync(workspace, { recursive: true });
    const originalPath = path.join(workspace, "original.txt");
    fs.writeFileSync(originalPath, "original bytes", "utf8");
    const runInput = {
      uiSessionId: "file-session",
      providerId: "codex",
      cwd: workspace,
      prompt: "Review the original file",
      approvalMode: "suggest",
      attachments: [
        {
          kind: "file",
          name: "original.txt",
          path: originalPath,
          handoffFileId: "attachment:file-1",
        },
      ],
      conversationContext: {
        schemaVersion: "1",
        handoffId: "h-file",
        workItemId: "w-file",
        toParticipantId: "provider:codex",
        sourceSeq: 0,
        highWatermarkSeq: 1,
        objective: "Review the original file",
        requestedAction: "review",
        digest: "digest",
        messages: [],
        files: [
          {
            id: "attachment:file-1",
            name: "original.txt",
            sourcePath: originalPath,
            uri: "agui-handoff://file/attachment%3Afile-1",
            availability: "pending",
          },
        ],
      },
    };
    const first = await prepareHandoffFiles(runInput, userData);
    assert.equal(first.files.length, 1);
    assert.equal(fs.readFileSync(first.files[0].snapshotPath, "utf8"), "original bytes");
    assert.equal(first.input.conversationContext.files[0].sourcePath, undefined);
    assert.equal(first.input.conversationContext.files[0].availability, "ready");
    assert.equal(first.input.attachments[0].handoffFileId, undefined);
    assert.equal(first.input.attachments[0].path, first.files[0].snapshotPath);
    fs.writeFileSync(originalPath, "changed later", "utf8");
    const second = await prepareHandoffFiles(runInput, userData);
    assert.equal(fs.readFileSync(second.files[0].snapshotPath, "utf8"), "original bytes");
    const provider = createHandoffFileMcpToolProvider(second.files);
    const listed = await provider.callTool("handoff_file_list", {});
    assert.equal(listed.files[0].id, "attachment:file-1");
    const read = await provider.callTool("handoff_file_read", {
      fileId: "attachment:file-1",
    });
    assert.equal(read.encoding, "utf8");
    assert.equal(read.content, "original bytes");

    const missingPath = path.join(workspace, "missing.txt");
    const missing = await prepareHandoffFiles(
      {
        ...runInput,
        attachments: [
          {
            kind: "file",
            name: "missing.txt",
            path: missingPath,
            handoffFileId: "attachment:missing",
          },
        ],
        conversationContext: {
          ...runInput.conversationContext,
          files: [
            {
              id: "attachment:missing",
              name: "missing.txt",
              sourcePath: missingPath,
              uri: "agui-handoff://file/attachment%3Amissing",
              availability: "pending",
            },
          ],
        },
      },
      userData,
    );
    assert.equal(missing.files.length, 0);
    assert.equal(missing.input.attachments.length, 0);
    assert.equal(missing.input.conversationContext.files[0].sourcePath, undefined);
    assert.equal(missing.input.conversationContext.files[0].availability, "missing");
    await cleanupHandoffFiles(userData, runInput.uiSessionId);
    assert.equal(fs.existsSync(first.files[0].snapshotPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

{
  const shared = session({
    blocks: [
      { id: "u1", kind: "user", text: "Implement it", conversationSeq: 10, createdAt: 1 },
      {
        id: "d1",
        kind: "diff",
        path: "src/app.ts",
        hunks: [{ oldStart: 1, newStart: 1, lines: [{ type: "add", text: "ok" }] }],
        status: "success",
        review: "accepted",
        conversationSeq: 11,
      },
      {
        id: "a1",
        kind: "assistant",
        text: "Implemented and tested.",
        streaming: false,
        agentProviderId: "codex",
        conversationSeq: 12,
      },
      { id: "u2", kind: "user", text: "Review it", conversationSeq: 13, createdAt: 2 },
    ],
    agentSessions: { claude: { status: "synced", seenThroughSeq: 9 } },
  });
  const first = buildAgentConversationContext(shared, "claude", {
    handoffId: "h1",
    workItemId: "w1",
    toParticipantId: providerParticipantId("claude"),
    objective: "Review it",
  });
  const second = buildAgentConversationContext(shared, "claude", {
    handoffId: "h2",
    workItemId: "w1",
    toParticipantId: providerParticipantId("claude"),
    objective: "Review it",
  });
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.digest, second.digest);
  assert.equal(first.highWatermarkSeq, 12);
  assert.equal(first.messages.at(-1)?.content, "Implemented and tested.");
  assert.equal(first.artifacts?.[0]?.kind, "diff");
  assert.equal(
    first.messages.some((message) => message.content === "Review it"),
    false,
  );
}

{
  const legacy = normalizeAgentOrchestration(
    session({
      blocks: [
        { id: "u1", kind: "user", text: "one" },
        { id: "a1", kind: "assistant", text: "two", streaming: false },
      ],
      agentSessions: { codex: { status: "synced", lastSyncedBlockId: "a1" } },
    }),
  );
  assert.equal(legacy.conversationRevision, 2);
  assert.equal(legacy.agentSessions.codex.seenThroughSeq, 2);
  assert.ok(legacy.agentParticipants[providerParticipantId("codex")]);

  const targeted = targetPromptForSession(
    legacy,
    { text: "next", targetProviderId: "claude" },
    { promptId: "p1", workItemId: "w1" },
  );
  assert.equal(targeted.targetProviderId, "claude");
  assert.equal(targeted.targetParticipantId, providerParticipantId("claude"));
  assert.equal(targeted.sourceSeq, 2);
}

{
  const started = projectAgentLifecycle(session(), {
    at: 10,
    event: "agent.started",
    providerId: "claude",
    runId: "parent-run",
    payload: { agentId: "reviewer", toolUseId: "tool-1", prompt: "Review changes" },
  });
  const participantId = "runtime:claude:tool-1";
  assert.equal(started.agentParticipants[participantId].status, "running");
  assert.equal(started.agentParticipants[participantId].parentRunId, "parent-run");
  const completed = projectAgentLifecycle(started, {
    at: 20,
    event: "agent.completed",
    providerId: "claude",
    runId: "parent-run",
    payload: { agentId: "reviewer", toolUseId: "tool-1", output: "Looks good" },
  });
  assert.equal(completed.agentParticipants[participantId].status, "completed");
  assert.equal(completed.agentRuns[`runtime-run:${participantId}`].status, "completed");
}

console.log("multi-agent session regression tests passed");
