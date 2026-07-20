/**
 * The doc-authoring skill (PLNR-190) — separate from the base work-loop skill on
 * purpose: the base skill loads every session; this one loads at the moment an agent
 * is about to WRITE knowledge, which is when authoring guidance actually lands.
 * Served at GET /skill/docs.md and as the MCP resource noriq://skill/doc-authoring
 * (pointed to from the create_doc/update_doc descriptions and the lint rejection).
 */
export const DOC_SKILL_MD = `---
name: noriq-doc-authoring
description: Author project docs in Noriq — use when writing, creating, restructuring, or ingesting knowledge-base docs (design decisions, conventions, architecture records, contracts and catalogs, game-design components, existing documentation trees) via create_doc/update_doc.
---

# Authoring Noriq docs

A doc is the project's long-term memory AND the corpus \`semantic_search\` retrieves
from. Tasks finish, plans close, comments scroll away, and files in a repo are
invisible to search here — **if knowledge is not in a doc, no future agent will find
it**. Write every doc to be found. Together the project's docs form its design
corpus: for a game project they ARE the Game Design Document, one component per doc
(combat model, economy, netcode seams); for a software project they are the
architecture, the decisions, the interface contracts, and the conventions — complete
enough that an agent can answer any "how does X work / what did we decide about Y /
what are the rules for Z" question from search alone.

The server enforces the floor — TBD/TODO markers, open questions, and "we should
discuss" phrasing are rejected at the write seam. This guide is the ceiling: prose
that is settled, specific, and expressive enough to drive work forward. Nothing
enforces coverage, so a thin corpus fails silently — agents don't see what isn't
indexed, they just re-derive or guess. Coverage is the author's job; this guide
tells you how.

## A doc is / is not

A doc IS: a settled decision with its rationale; an established fact; a convention;
a contract or catalog (topics, identifiers, error codes, ports); a component's
as-built architecture; settled reference material ingested from an authoritative
source; one component of the design corpus.

A doc IS NOT a home for anything that changes weekly or is still in motion:
- status or progress → the plan (\`update_plan\`) or a task comment
- an open question → \`request_input\`; document the ANSWER when it lands
- a brainstorm or option list → the plan body, until a decision is made
- work to be done → tasks
- a meeting-notes dump → distill the decisions into the relevant docs, drop the rest
- provisional design notes / supporting material a PLAN needs → a **plan doc**
  (\`create_plan_doc\`), NOT a project doc

**Plan docs vs project docs.** A plan doc (\`create_plan_doc\` / \`update_plan_doc\` /
\`get_plan_doc\`) is a working document scoped to one plan: it is NOT indexed for search,
carries NO settled-only rule, and dies with the plan. Use it for the design notes and
supporting material a plan generates while it works — things that are allowed to hold open
questions and change as the design firms up. Keep project docs (\`create_doc\`) for what has
settled and belongs to the project's long-term memory. When a plan doc's decision settles
and matters beyond the plan, restate it as a project doc.

## Coverage — the corpus, not just the doc

Completeness is judged twice. Each doc is complete for its own scope (see "Writing
the body") — and the CORPUS is complete when the project's settled knowledge is
searchable. The test: name a question a competent new agent would ask before
touching the work ("what are the Kafka producer guarantees?", "how do I add a new
service?", "who mints \`customer_id\`?"). If search cannot answer it and the answer
is settled, a doc is missing — write it, or file a task to write it. Distillation
is not coverage: a summary that names a topic without carrying its content lets
search find a pointer and nothing else.

## Ingesting existing sources

When authoritative material already exists outside Noriq (a repo \`docs/\` tree, a
wiki, a spec), **ingest it — a pointer is not retrieval**; search cannot follow a
link into a file it doesn't index.

- **Split at component seams.** A large source file holds several searchable
  components; give each its own doc that answers one question well. Never mirror
  file-per-file for its own sake, and never dump one 4,000-line doc.
- **Correct drift during ingestion.** Verify claims against reality as they go in;
  a known-stale claim gets fixed or dropped, never copied. The settled-only
  contract applies to every ingested claim — proposals, open questions, and dated
  snapshots stay out.
- **Stamp the source.** One line per ingested doc ("Source: docs/v3/mtls.md") so
  future updates flow both ways. When source and doc later disagree, reconcile
  both — never let them drift apart silently.

## Before you write

1. **Search first.** \`semantic_search\` + \`list_docs\` — the doc may already exist
   IN NORIQ. Revising the existing doc keeps its id, links, and citations; a
   near-duplicate inside the corpus forks the truth and misleads whoever finds the
   wrong copy. This rule is about duplicates inside the corpus — it is never a
   reason to leave authoritative external content un-ingested. An un-ingested
   source isn't an avoided duplicate; it's a retrieval hole.
2. **Settle the document's claims — and only its claims.** Do not encode an
   unresolved choice as a fact. But an open question OUTSIDE the doc's scope does
   not block the doc: narrow the boundary and ship what is settled. A combat damage
   model can be fully documented while the launch weapon roster is still open — the
   doc states the model and simply does not claim the roster. Raise
   \`request_input\` only when the unresolved issue blocks the doc's CENTRAL
   decision; then write the outcome.
3. **Place it.** Folder = where a human browses to it (reuse existing paths — see
   list_docs — before minting new ones). Tags = the project's shared FILTER
   vocabulary, the same one tasks use: 1–3 per doc, reused from the existing set
   (get_project.tags), and a tag only deserves to exist if it will group 3+ items —
   the server rejects near-duplicates, and curated projects reject agent-minted
   tags entirely. Never restate the folder or the title as a tag: finding one
   specific doc is semantic search's job, tags are for slicing the corpus. Name +
   one-line description are retrieval keys twice over — humans scan them in
   list_docs, and embeddings match queries against them — so load the description
   with the terms an agent would actually search: "Vehicle mesh replication" beats
   "Networking notes".

## Writing the body

- **Lead with the decision.** First paragraph states what IS, not the journey there.
- **No speculative language.** "Might", "we could", "probably", "we'll figure out"
  describe wishes — settle the point or leave it out of scope. Normative
  requirement terms are NOT speculation: "clients SHOULD retry idempotent requests
  twice" and RFC-style MUST/SHOULD/MAY are precise contract language — use them for
  contracts, and plain declarative present tense for how things are.
- **Say which kind of truth each claim is.** An observed fact ("the gateway
  currently accepts 2 MB bodies"), a decision/contract ("the gateway limit IS
  2 MB; services MUST reject larger with 413"), and a future intention are
  different authorities — a reader must never wonder whether a sentence describes
  how the system behaves or how it is required to behave. Avoid future tense
  entirely: planned work belongs in tasks/plans, unless the doc explicitly records
  an approved target-state architecture and says so.
- **State rule + rationale in one breath.** "Access tokens live 15 minutes —
  refresh rotation bounds the blast radius of a leaked token." Rationale is what
  lets a future reader extend the decision instead of accidentally reversing it.
- **Concrete values, not adjectives.** Numbers, names, units, limits: "1.5 KB
  durable blob on the reliable lane at 20 Hz", never "small state updates sent
  frequently". Spell out the literals — topic names, package paths, table names,
  task keys — those exact strings are what agents query for.
- **Cite non-obvious sources.** Measurements, external platform limits, tuning
  values, and stakeholder decisions carry their provenance ("tuned in NOD-52",
  "per Workers limits docs", "decided by Montana on PLNR-100"). Never present an
  inference from reading code as an established contract unless it has been
  confirmed as intentional — that canonizes implementation accidents.
- **One retrieval unit per doc, complete for ITS scope.** A doc should answer one
  question an agent would search for, and is complete when every claim needed to
  answer that question is settled and supported — it owes nothing about adjacent
  components. A 600-line spec is several docs; a two-line fact is a line in an
  existing doc, not a new one. Don't postpone a settled doc waiting on neighbors,
  and don't bloat one to look "complete". When a section grows its own audience,
  split it out and reference it by name.
- **Supersede in one line.** When a decision changes, rewrite the doc to the new
  truth and note "Supersedes: X — changed because Y" once. A doc is not a
  changelog; history lives in the event log.
- **A conflict is not an edit.** When your task appears to contradict what a doc
  states, that is an unresolved conflict, not permission to rewrite: raise
  \`request_input\` unless the task or a human explicitly authorizes superseding
  the documented decision. A low-context task must never silently overwrite the
  project's durable truth.

## Shapes that work

Pick the shape that fits; do not force every heading onto every doc.

- **Design component** (GDD chapter): what the system is (one paragraph) → its
  rules/mechanics as declarative facts → its seams (how other systems touch it) →
  constraints and their rationale.
- **Decision record**: context (the forces) → the decision → consequences (what
  this makes easy, what it forbids).
- **Convention**: the rule → why → a right and a wrong example, verbatim.
- **Reference / catalog**: the authoritative table or list (topics, identifiers,
  error codes, endpoints) → per-entry semantics → known divergences from any
  target-state spec, each labeled as-built vs target.

## Wrong vs right, verbatim

- ✗ "We still need to figure out spawn rates." → ask via request_input, then:
  ✓ "Spawn rate is 12/min per shard, tuned against the K=32 pool test (NOD-52)."
- ✗ "TODO: fill in the weapon damage table." → either the table is settled (write
  it) or it is outside this doc's scope (say so and ship without it) — an
  unfinished placeholder is neither.
- ✗ "As of this sprint, inventory work is in progress." → status; belongs on the plan.
- ✗ "Networking doc v2 (draft)" as a NEW doc → update the original; drafts and
  versions fork the truth.
- ✗ "Platform conventions (summary)" distilling a 4,000-line spec into 40 bullets
  and leaving the spec un-ingested → a search for "cert rotation with connection
  pools" returns nothing.
  ✓ Split the spec into per-component docs (secrets resolution, local-dev
  workflow, Kafka conventions, …), each source-stamped and corrected to current
  truth.

## After writing

Link the tasks that implement or must follow the doc (\`docIds\` on
create_task/update_task) — workers read a task's related docs before starting, so
an unlinked doc protects nobody. When your work changes what a doc states, updating
that doc is part of finishing the task, not optional follow-up.
`;
