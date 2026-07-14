// PLNR-23: the MCP tool reference, generated from the exact same zod schemas the
// tools validate against — so it cannot drift from the implementation. Served at
// /reference.md (and /reference.json) alongside /skill.md.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { mcpReferenceSpecs } from './mcp';

/* eslint-disable @typescript-eslint/no-explicit-any */
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
};

/** Compact type label for a property, e.g. `string`, `array<object>`, `"a" | "b"`. */
function typeLabel(p: JsonSchema): string {
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (p.type === 'array') return `array<${p.items ? typeLabel(p.items) : 'any'}>`;
  return Array.isArray(p.type) ? p.type.join('|') : p.type ?? 'any';
}

function constraints(p: JsonSchema): string {
  const bits: string[] = [];
  if (p.minLength !== undefined) bits.push(`min ${p.minLength}`);
  if (p.maxLength !== undefined) bits.push(`max ${p.maxLength}`);
  if (p.minimum !== undefined) bits.push(`≥ ${p.minimum}`);
  if (p.maximum !== undefined) bits.push(`≤ ${p.maximum}`);
  if (p.format) bits.push(p.format);
  return bits.length ? ` _(${bits.join(', ')})_` : '';
}

/** One markdown bullet per property, one level of nesting for objects/arrays-of-objects. */
function renderProps(schema: JsonSchema, indent = ''): string[] {
  const req = new Set(schema.required ?? []);
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const flag = req.has(name) ? 'required' : 'optional';
    const desc = prop.description ? ` — ${prop.description}` : '';
    lines.push(`${indent}- \`${name}\` **${typeLabel(prop)}** (${flag})${constraints(prop)}${desc}`);
    // Descend one level for object shapes (e.g. create_plan phases).
    const nested = prop.type === 'array' ? prop.items : prop;
    if (nested?.type === 'object' && nested.properties) {
      lines.push(...renderProps(nested, indent + '  '));
    }
  }
  return lines;
}

export function renderMcpReference(baseUrl: string): string {
  const { tools, resources } = mcpReferenceSpecs();
  const out: string[] = [];
  out.push('# Noriq MCP — tool reference');
  out.push('');
  out.push('_Generated from the live zod schemas; this file cannot drift from the server._');
  out.push('');
  out.push(`Connect: \`claude mcp add -s user --transport http noriq ${baseUrl}/mcp\``);
  out.push('');
  out.push('The contract: call `get_briefing` first, `claim_task` before working, resolve open comments, `release_task` when done. Every tool call renews your claim.');
  out.push('');
  out.push(`## Tools (${tools.length})`);
  for (const t of tools) {
    out.push('');
    out.push(`### \`${t.name}\``);
    out.push('');
    out.push(t.description);
    const schema = zodToJsonSchema(z.object(t.inputSchema)) as JsonSchema;
    const props = renderProps(schema);
    out.push('');
    out.push(props.length ? props.join('\n') : '_No parameters._');
  }
  out.push('');
  out.push(`## Resources (${resources.length})`);
  for (const r of resources) {
    out.push('');
    out.push(`### \`${r.uriTemplate}\``);
    out.push('');
    out.push(r.description);
  }
  out.push('');
  return out.join('\n');
}

/** Machine-readable variant: names, descriptions, and JSON Schema per tool. */
export function mcpReferenceJson(): unknown {
  const { tools, resources } = mcpReferenceSpecs();
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: zodToJsonSchema(z.object(t.inputSchema)) })),
    resources,
  };
}
