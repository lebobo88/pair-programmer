import { z } from "zod";

/**
 * Convert a thrown value into MCP tool error content. We never let an
 * exception escape the handler — the SDK closes the transport on uncaught
 * exceptions, which would force Claude Code to reconnect.
 */
export function errorContent(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && process.env.PP_DEBUG ? `\n\n${err.stack}` : "";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}${stack}` }],
  };
}

export function jsonContent(value: unknown) {
  // JSON.stringify(undefined) returns undefined which breaks the MCP wire
  // contract (content[0].text must be a string). Use null as a stand-in for
  // void-returning tools.
  const text = value === undefined ? "null" : JSON.stringify(value, null, 2);
  return {
    content: [
      { type: "text" as const, text },
    ],
  };
}

/** Adapt a zod schema to JSON Schema for MCP tool inputSchema. */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal hand-rolled converter for the subset we use. Avoids pulling in
  // zod-to-json-schema. Extend as new shapes appear.
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToJsonSchema(v);
      if (!v.isOptional()) required.push(k);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodNullable) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault)  return zodToJsonSchema(schema._def.innerType);
  // .refine() / .transform() / .preprocess() wrap the underlying type in
  // ZodEffects. The MCP SDK requires inputSchema.type === "object" at the
  // root, so we unwrap to the inner schema for shape discovery; runtime
  // validation still runs the refinements via .parse() in the handler.
  if (schema instanceof z.ZodEffects) return zodToJsonSchema(schema._def.schema);
  if (schema instanceof z.ZodArray)    return { type: "array", items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum)     return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodLiteral)  return { const: schema.value };
  if (schema instanceof z.ZodUnion)    return { anyOf: schema.options.map(zodToJsonSchema) };
  if (schema instanceof z.ZodString)   return { type: "string" };
  if (schema instanceof z.ZodNumber)   return { type: "number" };
  if (schema instanceof z.ZodBoolean)  return { type: "boolean" };
  if (schema instanceof z.ZodAny)      return {};
  if (schema instanceof z.ZodUnknown)  return {};
  if (schema instanceof z.ZodRecord)   return { type: "object", additionalProperties: zodToJsonSchema(schema.valueSchema) };
  // Fallback — let MCP accept anything; runtime validation still happens via parse().
  return {};
}
