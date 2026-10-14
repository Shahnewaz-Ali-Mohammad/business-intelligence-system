import {namedKeyLinks} from './named-key-links.mjs';
import {
  fingerprint,
  fieldId,
  isProtectedColumn,
  validateTool,
} from "./model.mjs";

export function coverageTools(catalog) {
  catalog=namedKeyLinks(catalog);
  return catalog.objects.flatMap((base) => {
    const reachable = new Set([base.id]);
    const joins = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const join of catalog.relationships) {
        if (
          join.targetUnique &&
          (reachable.has(join.from) || reachable.has(join.to)) &&
          (!reachable.has(join.from) || !reachable.has(join.to)) &&
          catalog.objects.some((o) => o.id === join.from) && catalog.objects.some((o) => o.id === join.to)
        ) {
          reachable.add(join.from);reachable.add(join.to);
          changed = true;
        }
      }
    }
    joins.push(...catalog.relationships.filter(j=>j.targetUnique&&reachable.has(j.from)&&reachable.has(j.to)&&j.from!==j.to).map(j=>j.id));
    const fields = catalog.objects
      .filter((o) => reachable.has(o.id))
      .flatMap((o) =>
        o.columns
          .filter((c) => !isProtectedColumn(c.name))
          .map((c) => fieldId(o, c)),
      );
    const columns = base.columns
      .filter((c) => !isProtectedColumn(c.name))
      .map((c) => fieldId(base, c))
      .slice(0, 30);
    if (!columns.length) return [];
    return ["rows", "aggregate"].map((mode) => {
      const tool = {
        name: `schema_${fingerprint(base.id).slice(0, 16)}_${mode}`,
        description: `Read-only ${mode} for ${base.schema}.${base.name}. Use query JSON to choose approved columns, joins, filters and values, or grouping and count/sum/avg/min/max metrics. Results are a bounded preview; aggregates use the full matching dataset. Do not treat identifier fields as business amounts.`,
        base: base.id,
        mode,
        joins: [],
        columns: mode === "rows" ? columns : [],
        groupBy: [],
        metrics:
          mode === "aggregate"
            ? [{ field: null, operation: "count", alias: "record_count" }]
            : [],
        filters: [],
        capabilities: { fields, joins },
      };
      validateTool(tool, catalog);
      return tool;
    });
  });
}

export function generationBatches(catalog) {
  // Keep ordinary selections together so the model sees complete fields and relationships once.
  if (catalog.objects.reduce((n, o) => n + o.columns.length, 0) <= 200) return [catalog];
  const batches = [];
  for (const object of catalog.objects) {
    for (let offset = 0; offset < object.columns.length; offset += 100) {
      const slice = {
        ...object,
        columns: object.columns.slice(offset, offset + 100),
      };
      batches.push({ ...catalog, objects: [slice], relationships: [] });
    }
  }
  for (const join of catalog.relationships.filter(
    (j) => j.targetUnique && j.from !== j.to,
  )) {
    const from = catalog.objects.find((o) => o.id === join.from);
    const to = catalog.objects.find((o) => o.id === join.to);
    if (!from || !to) continue;
    const pick = (object, side) => {
      const keys = new Set(join.columns.map((c) => c[side]));
      return {
        ...object,
        columns: object.columns
          .filter((c) => keys.has(c.name))
          .concat(object.columns.filter((c) => !keys.has(c.name)).slice(0, 99)),
      };
    };
    batches.push({
      ...catalog,
      objects: [pick(from, "from"), pick(to, "to")],
      relationships: [join],
    });
  }
  return batches;
}

export function coverageReport(catalog,definitions){
 catalog=namedKeyLinks(catalog);
 const bases=new Set(definitions.map(t=>t.base));
 const fields=new Set(definitions.flatMap(t=>t.capabilities?.fields||[...t.columns,...t.groupBy,...t.metrics.map(m=>m.field).filter(Boolean)]));
 const joinIds=new Set(definitions.flatMap(t=>t.capabilities?.joins||t.joins));
 const relationships=catalog.relationships.filter(j=>bases.has(j.from)&&bases.has(j.to));
 return {tables:catalog.objects.filter(o=>bases.has(o.id)).map(o=>({id:o.id,name:o.name,fields:o.columns.filter(c=>fields.has(`${o.id}:${c.name}`)).length})),totalFields:fields.size,verifiedRelationships:joinIds.size,inferredRelationships:relationships.filter(j=>j.kind==='inferred_named_primary_key'&&joinIds.has(j.id)).length,
   scenarios:definitions.some(t=>t.template)?['Saved record and lookup templates','Typed value binding without AI-built joins or calculations','Stored summaries, rankings and date trends','Targeted generation for missing combinations']:['Selected or all approved columns','Single records and ID lists','Nested AND/OR/NOT filters and ranges','Multiple sort fields and pagination','Distinct rows and distinct counts','Grouping and date buckets','Verified joins in both directions'],
   gaps:relationships.filter(j=>!joinIds.has(j.id)).map(j=>({relationship:j.id,reason:j.from===j.to?'Self joins require separate aliases':!j.targetUnique?'Target uniqueness is not verified':'Select the relationship key columns to enable this path'})),
   limitations:['Independent child-table sums need separate aggregations; multiplying joins are rejected','Disconnected tables and ambiguous join paths are not guessed']};
}
