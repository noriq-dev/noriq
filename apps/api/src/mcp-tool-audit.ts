import { z } from 'zod';
import type { ResourceSpec, ToolSpec } from './mcp';

const CONSTRAINT_KEYS = ['minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'enum', 'minItems', 'maxItems'] as const;

export interface McpCatalogAuditFinding {
  code: string;
  subject: string;
  message: string;
}

export interface McpCatalogAudit {
  valid: boolean;
  toolCount: number;
  resourceCount: number;
  findings: McpCatalogAuditFinding[];
}

/**
 * Static, deterministic audit over the SAME captured specs used by tools/list and reference.json.
 * It cannot prove a handler's business result without invoking it, but it closes the catalogue
 * failure modes that made PLNR-353 possible: omitted registrations, malformed schemas, implicit
 * annotations, misleading authorization floors, and destructive tools advertised as harmless.
 */
export function auditMcpCatalog(input: { tools: ToolSpec[]; resources: ResourceSpec[] }): McpCatalogAudit {
  const findings: McpCatalogAuditFinding[] = [];
  const add = (code: string, subject: string, message: string) => findings.push({ code, subject, message });
  const seenTools = new Set<string>();
  const seenResources = new Set<string>();

  for (const tool of input.tools) {
    if (seenTools.has(tool.name)) add('duplicate-tool', tool.name, 'tool name is registered more than once');
    seenTools.add(tool.name);
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) add('invalid-tool-name', tool.name, 'name must be lower snake_case');
    if (tool.description.trim().length < 40) add('weak-description', tool.name, 'description is too short to teach selection and behavior');

    try {
      const json = z.toJSONSchema(z.object(tool.inputSchema), { io: 'input', unrepresentable: 'any' }) as {
        properties?: Record<string, Record<string, unknown>>;
      };
      // PLNR-551: a limit the agent can only discover from the -32602 rejection is a trap. Every
      // top-level field that carries a constraint must also say, in words, what the constraint
      // means (nested shapes are the shared-schema's responsibility, checked where they live).
      for (const [field, prop] of Object.entries(json.properties ?? {})) {
        const constrained = CONSTRAINT_KEYS.some((key) => key in prop);
        if (constrained && typeof prop.description !== 'string') {
          add('undescribed-constraint', `${tool.name}.${field}`, 'field carries a limit/enum/pattern but no description explaining it');
        }
      }
    } catch (error) {
      add('invalid-input-schema', tool.name, error instanceof Error ? error.message : String(error));
    }

    const hints = tool.annotations;
    if (typeof hints.readOnlyHint !== 'boolean') add('missing-readonly-hint', tool.name, 'readOnlyHint must be explicit');
    if (hints.openWorldHint !== false) add('open-world-tool', tool.name, 'Noriq tools must be closed-world');
    if (hints.readOnlyHint === true) {
      if (hints.destructiveHint === true) add('destructive-read', tool.name, 'a read-only tool cannot be destructive');
      if (tool.minimumProjectAction !== 'view') add('read-floor', tool.name, 'read-only tools must require only view access');
    } else {
      if (typeof hints.destructiveHint !== 'boolean') add('missing-destructive-hint', tool.name, 'write tools must state destructiveHint explicitly');
      if (typeof hints.idempotentHint !== 'boolean') add('missing-idempotent-hint', tool.name, 'write tools must state idempotentHint explicitly');
    }
    if (hints.destructiveHint === true && !/delete|discard|drop|sever|dissolve|remove/i.test(tool.description)) {
      add('undisclosed-destruction', tool.name, 'description does not explain the advertised destructive effect');
    }

    const projectField = tool.inputSchema.projectId;
    if (projectField) {
      const field = projectField as z.ZodType;
      if (!field.safeParse('prj_audit').success) add('invalid-project-id', tool.name, 'projectId does not accept a string');
      if (tool.minimumProjectAction === 'account') add('account-project-mismatch', tool.name, 'project-bearing tool cannot use the account-only floor');
    }
  }

  for (const resource of input.resources) {
    if (seenResources.has(resource.uriTemplate)) add('duplicate-resource', resource.uriTemplate, 'resource URI is registered more than once');
    seenResources.add(resource.uriTemplate);
    if (!resource.description.trim()) add('weak-resource-description', resource.uriTemplate, 'resource description is empty');
    if (resource.minimumProjectAction !== 'view') add('resource-floor', resource.uriTemplate, 'MCP resources are read-only and must require view');
  }

  return {
    valid: findings.length === 0,
    toolCount: input.tools.length,
    resourceCount: input.resources.length,
    findings,
  };
}
