import { SKILL_MD, SKILL_REFERENCES } from './skill';
import { DOC_SKILL_MD } from './skill-docs';

const encoder = new TextEncoder();

const ARCHIVE_ROUTER = `
## Prefer live guidance when connected

This archive is a portable snapshot. At the start of every connected session, call
\`get_briefing\`; its live playbook overrides this downloaded copy. Before using a specialized
workflow, prefer the current MCP resource over the bundled reference:

- \`noriq://skill/core\` — current core skill
- \`noriq://skill/file-locks\` — file-locking protocol
- \`noriq://skill/planning\` — plans and execution specs
- \`noriq://skill/memory\` — project-memory retrieval and recording
- \`noriq://skill/doc-authoring\` — durable project docs

If a bundled instruction and a live resource disagree, follow the live resource. It reflects the
server and tool contracts you are actually connected to.

If the live resource is unavailable, read only the bundled reference needed for the current work:

- [File locks](references/file-locks.md) — before editing when project locking is enabled
- [Planning](references/planning.md) — before plans, templates, phase changes, or execution specs
- [Project memory](references/memory.md) — before memory retrieval, graph explanation, or recording
- [Doc authoring](references/doc-authoring.md) — before creating or substantially revising project docs
`;

function withArchiveRouter(skill: string): string {
  const frontmatterEnd = skill.indexOf('\n---\n', 4);
  if (frontmatterEnd === -1) throw new Error('Noriq skill frontmatter is malformed');
  const insertAt = frontmatterEnd + '\n---\n'.length;
  return `${skill.slice(0, insertAt)}${ARCHIVE_ROUTER}\n${skill.slice(insertAt)}`;
}

export const ARCHIVE_OPENAI_YAML = `interface:
  display_name: "Noriq"
  short_description: "Coordinate project work through Noriq"
  default_prompt: "Use $noriq to coordinate and complete this project work through the connected Noriq server."
policy:
  allow_implicit_invocation: true
`;

export function noriqSkillFiles(): Readonly<Record<string, string>> {
  return {
    'noriq/SKILL.md': withArchiveRouter(SKILL_MD),
    'noriq/agents/openai.yaml': ARCHIVE_OPENAI_YAML,
    'noriq/references/file-locks.md': SKILL_REFERENCES['file-locks']!,
    'noriq/references/planning.md': SKILL_REFERENCES.planning!,
    'noriq/references/memory.md': SKILL_REFERENCES.memory!,
    'noriq/references/doc-authoring.md': DOC_SKILL_MD,
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Deterministic, dependency-free ZIP writer using STORE entries (the skill is already text). */
export function buildNoriqSkillArchive(): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let localOffset = 0;
  const entries = Object.entries(noriqSkillFiles()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

  for (const [path, content] of entries) {
    const name = encoder.encode(path);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800); // UTF-8 names
    write16(localView, 8, 0); // STORE
    write16(localView, 10, 0); // deterministic time 00:00
    write16(localView, 12, 0x0021); // deterministic date 1980-01-01
    write32(localView, 14, checksum);
    write32(localView, 18, data.byteLength);
    write32(localView, 22, data.byteLength);
    write16(localView, 26, name.byteLength);
    write16(localView, 28, 0);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);

    const directory = new Uint8Array(46 + name.byteLength);
    const directoryView = new DataView(directory.buffer);
    write32(directoryView, 0, 0x02014b50);
    write16(directoryView, 4, 20);
    write16(directoryView, 6, 20);
    write16(directoryView, 8, 0x0800);
    write16(directoryView, 10, 0);
    write16(directoryView, 12, 0);
    write16(directoryView, 14, 0x0021);
    write32(directoryView, 16, checksum);
    write32(directoryView, 20, data.byteLength);
    write32(directoryView, 24, data.byteLength);
    write16(directoryView, 28, name.byteLength);
    write16(directoryView, 30, 0);
    write16(directoryView, 32, 0);
    write16(directoryView, 34, 0);
    write16(directoryView, 36, 0);
    write32(directoryView, 38, 0);
    write32(directoryView, 42, localOffset);
    directory.set(name, 46);
    central.push(directory);
    localOffset += local.byteLength;
  }

  const centralSize = central.reduce((total, part) => total + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 4, 0);
  write16(endView, 6, 0);
  write16(endView, 8, entries.length);
  write16(endView, 10, entries.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, localOffset);
  write16(endView, 20, 0);
  return join([...locals, ...central, end]);
}
