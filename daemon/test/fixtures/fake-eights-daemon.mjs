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
//   2. The `eights.memory.add` handler echoes back
//      `process.env.PP_UNIT_TEST_ENV_MARKER` so the test can prove the
//      spawned child actually received an env var that is NOT on the MCP
//      SDK's default Windows/POSIX inherited-env safelist (see
//      `DEFAULT_INHERITED_ENV_VARS` in
//      @modelcontextprotocol/sdk/client/stdio.js) — i.e. that
//      `eights-client.ts`'s `probe()` is passing `env` explicitly to
//      `StdioClientTransport` rather than relying on the SDK's default.

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
            env_marker: process.env.PP_UNIT_TEST_ENV_MARKER ?? null,
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
