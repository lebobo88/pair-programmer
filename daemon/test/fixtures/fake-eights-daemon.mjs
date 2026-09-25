// Minimal fake TheEights MCP stdio server, used ONLY by
// eights-client-listtools.unit.mjs. No live TheEights daemon required.
//
// Reproduces two real conditions observed against the actual TheEights
// daemon (see eights-integration.smoke.mjs header + eights-client.ts
// comments for the full write-up):
//
//   1. One tool (`eights.evolution.register`) is registered with an
//      `inputSchema` that has NO `type` field at all — this is exactly what
//      TheEights' hand-rolled `zodToJsonSchema` (daemon/src/mcp/zod-to-json.ts
//      in the TheEights repo) emits for a top-level `z.object({...}).refine(...)`
//      schema (a `ZodEffects` node its `walk()` switch has no case for, so it
//      falls through to `default: return {}`). The MCP SDK's
//      `ListToolsResultSchema` requires `inputSchema.type` to be the zod
//      literal `"object"` for EVERY listed tool, so `client.listTools()`
//      throws on this tools/list response — even though the tool the caller
//      actually cares about (`eights.memory.*`) is perfectly well-formed.
//
//   2. The `eights.memory.add` handler echoes back two env vars so the test
//      can prove `eights-client.ts`'s `scopedEightsEnv()` allowlist forwards
//      exactly what it should and nothing more:
//        - `process.env.EIGHTS_UNIT_TEST_MARKER` (an `EIGHTS_*`-prefixed var,
//          not on the MCP SDK's default Windows/POSIX inherited-env safelist)
//          MUST reach the spawned child — proves the allowlist forwards the
//          `EIGHTS_*` namespace.
//        - `process.env.PP_TEST_FAKE_SECRET_TOKEN` (a secret-shaped var that
//          is NOT `EIGHTS_*`-prefixed and NOT in `ADDITIONAL_FORWARDED_ENV_VARS`)
//          must NOT reach the spawned child — proves the allowlist doesn't
//          degrade back into a full parent-env copy.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fake-eights-daemon", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "eights.memory.add",
      description: "fixture memory.add",
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
    {
      // Deliberately malformed — mirrors TheEights' real
      // zod-to-json.ts fallthrough for a top-level `.refine()`'d schema.
      name: "eights.evolution.register",
      description: "fixture evolution.register (malformed inputSchema, on purpose)",
      inputSchema: {},
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "eights.memory.add") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "mem_fixture_1",
            eights_env_marker: process.env.EIGHTS_UNIT_TEST_MARKER ?? null,
            secret_env_marker: process.env.PP_TEST_FAKE_SECRET_TOKEN ?? null,
          }),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `fixture: unknown tool ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
