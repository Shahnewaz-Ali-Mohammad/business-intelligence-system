// The one genuinely custom AI step in workspace onboarding: given a
// structured schema introspection (bi-warehouse's introspectPostgres.mjs),
// propose a candidate semantic model -- one "cube" per table, with
// measures, dimensions, and joins -- for a human to review and edit before
// anything is confirmed live (see app/api/workspaces/[id]/confirm-model).
//
// Mirrors this app's existing structured-output pattern from
// scripts/chat/agent.mjs (ChatOpenAI + withStructuredOutput(zodSchema)),
// not a bespoke call style.
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

const FieldSchema = z.object({
  name: z.string(),
  sql: z.string(),
  type: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string(),
});

const CubeSchema = z.object({
  table: z.string(),
  cubeName: z.string(),
  measures: z.array(FieldSchema),
  dimensions: z.array(FieldSchema),
  joins: z.array(
    z.object({
      toCube: z.string(),
      sql: z.string(),
      relationship: z.string(),
    })
  ),
});

const DraftSchema = z.object({ cubes: z.array(CubeSchema) });

const SYSTEM_PROMPT = `You are a data-modeling assistant. You are given a JSON description of a
database's tables, columns, foreign keys, sample rows, and distinct-value
counts. Propose a semantic-layer data model: one cube per table, with
sensible measures (counts, sums/avgs of numeric columns), dimensions
(id/name/date/low-cardinality columns), and joins derived strictly from
the given foreign keys.

Rules:
- Never invent a business meaning that isn't visible in the schema, column
  names, or sample data (e.g. do not guess what a bare numeric status/type
  code means unless a same-row text column or a real foreign key to a
  lookup table makes it explicit) -- mark anything you are not fully sure
  about with confidence "low" or "medium" and explain why in "reasoning".
- Every foreign key becomes a join, direction inferred from the FK itself.

Output format rules (these are Cube's actual schema types, not SQL types --
using anything else fails validation and blocks the whole model):
- Measure "type" must be exactly one of: count, number, sum, avg, min, max,
  countDistinct, countDistinctApprox, string, time, boolean. Never "integer".
- Measure "sql" must be the bare column expression with NO aggregate function
  wrapper -- write "customer_id", never "COUNT(customer_id)". Cube applies
  the aggregation itself based on "type".
- Dimension "type" must be exactly one of: string, number, time, boolean, geo.
  Never "text", "integer", "timestamp", "date", or "varchar".`;

// withStructuredOutput's return type doesn't survive being cached in a module-level variable
// across calls; the actual shape is validated by DraftSchema.parse() at the one call site below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedDraftModel: any;
function getDraftModel() {
  if (!cachedDraftModel) {
    cachedDraftModel = new ChatOpenAI({
      model: process.env.SCHEMA_DRAFT_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o',
      temperature: 0,
    }).withStructuredOutput(DraftSchema);
  }
  return cachedDraftModel;
}

export interface DraftResult {
  cubes: z.infer<typeof CubeSchema>[];
  yaml: string;
}

export async function draftSemanticModel(introspection: unknown): Promise<DraftResult> {
  const model = getDraftModel();
  const raw = await model.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(introspection) },
  ]);
  const result = DraftSchema.parse(raw);
  const yaml = cubesToYaml(result.cubes);
  return { cubes: result.cubes, yaml };
}

// Hand-rolled YAML serialization (not a generic library) -- the shape is
// small and fixed, and this keeps output formatting predictable and
// diffable in the review screen.
// Covers every raw introspection/SQL type name we've actually seen a draft
// use in place of Cube's own vocabulary (information_schema type names,
// Postgres-specific spellings, and plain SQL types) -- anything not in this
// list passes through unchanged rather than silently becoming wrong.
const TYPE_ALIAS_MAP: Record<string, string> = {
  integer: 'number', int: 'number', smallint: 'number', bigint: 'number',
  float: 'number', 'double precision': 'number', real: 'number',
  decimal: 'number', numeric: 'number', number: 'number',
  text: 'string', varchar: 'string', char: 'string', 'character varying': 'string',
  character: 'string', string: 'string', uuid: 'string', json: 'string', jsonb: 'string',
  timestamp: 'time', timestamptz: 'time', 'timestamp with time zone': 'time',
  'timestamp without time zone': 'time', date: 'time', datetime: 'time', time: 'time',
  boolean: 'boolean', bool: 'boolean', geo: 'geo',
  count: 'count', sum: 'sum', avg: 'avg', min: 'min', max: 'max',
  countdistinct: 'countDistinct', countdistinctapprox: 'countDistinctApprox',
};
const MEASURE_TYPE_MAP = TYPE_ALIAS_MAP;
const DIMENSION_TYPE_MAP = TYPE_ALIAS_MAP;
const AGG_FN_MAP: Record<string, string> = { COUNT: 'count', SUM: 'sum', AVG: 'avg', MIN: 'min', MAX: 'max' };

// The model is asked not to do this (see SYSTEM_PROMPT), but a draft is
// still untrusted input to Cube's compiler -- normalize defensively so a
// drifted response never produces an invalid model file.
function normalizeMeasure(m: z.infer<typeof FieldSchema>): { sql: string; type: string } {
  const aggMatch = m.sql.match(/^\s*(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(.*?)\s*\)\s*$/i);
  if (aggMatch) {
    const fn = aggMatch[1].toUpperCase();
    return { sql: aggMatch[2], type: AGG_FN_MAP[fn] ?? m.type };
  }
  return { sql: m.sql, type: MEASURE_TYPE_MAP[m.type.toLowerCase()] ?? m.type };
}

function normalizeDimensionType(type: string): string {
  return DIMENSION_TYPE_MAP[type.toLowerCase()] ?? type;
}

function toIdentifier(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => (p === p.toUpperCase() ? p : p[0].toUpperCase() + p.slice(1)))
    .join('');
}

function cubesToYaml(cubes: z.infer<typeof CubeSchema>[]): string {
  const nameMap = new Map(cubes.map((c) => [c.cubeName, toIdentifier(c.cubeName)]));
  const lines: string[] = ['cubes:'];
  for (const cube of cubes) {
    lines.push(`  - name: ${nameMap.get(cube.cubeName)}`);
    lines.push(`    sql_table: ${cube.table}`);
    lines.push(`    measures:`);
    for (const m of cube.measures) {
      const { sql, type } = normalizeMeasure(m);
      lines.push(`      - name: ${m.name}`);
      lines.push(`        sql: ${sql}`);
      lines.push(`        type: ${type}`);
      lines.push(`        # confidence: ${m.confidence} -- ${m.reasoning}`);
    }
    lines.push(`    dimensions:`);
    for (const d of cube.dimensions) {
      lines.push(`      - name: ${d.name}`);
      lines.push(`        sql: ${d.sql}`);
      lines.push(`        type: ${normalizeDimensionType(d.type)}`);
      lines.push(`        # confidence: ${d.confidence} -- ${d.reasoning}`);
    }
    if (cube.joins.length > 0) {
      lines.push(`    joins:`);
      for (const j of cube.joins) {
        lines.push(`      - name: ${nameMap.get(j.toCube) ?? toIdentifier(j.toCube)}`);
        lines.push(`        sql: ${j.sql}`);
        lines.push(`        relationship: ${j.relationship}`);
      }
    }
  }
  return lines.join('\n');
}
