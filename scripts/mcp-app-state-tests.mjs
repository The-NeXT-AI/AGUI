import assert from "node:assert/strict";
import {
  MAX_MCP_APP_STATE_BYTES,
  boundedMcpAppStatePatch,
} from "../packages/app/src/chat/mcp-app-state.ts";

const source = { nested: { value: "ok" } };
const bounded = boundedMcpAppStatePatch({
  widgetState: source,
  modelContext: { content: [{ type: "text", text: "model context" }] },
});
assert.deepEqual(bounded.widgetState, source);
assert.notEqual(
  bounded.widgetState,
  source,
  "Interactive app state must be cloned at the boundary.",
);

const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => boundedMcpAppStatePatch({ widgetState: cyclic }), /must not contain cycles/);

let deeplyNested = {};
for (let index = 0; index < 40; index += 1) deeplyNested = { child: deeplyNested };
assert.throws(
  () => boundedMcpAppStatePatch({ widgetState: deeplyNested }),
  /maximum nesting depth/,
);

assert.throws(
  () => boundedMcpAppStatePatch({ widgetState: "x".repeat(MAX_MCP_APP_STATE_BYTES + 1) }),
  /256 KB limit/,
);

console.log("✓ MCP App state serialization and quota contracts");
