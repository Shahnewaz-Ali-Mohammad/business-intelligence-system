import {
  fingerprint,
  fieldId,
  isProtectedColumn,
  validateTool,
} from "./model.mjs";

export function coverageTools(catalog) {
  return catalog.objects.flatMap((base) => {
    const reachable = new Set([base.id]);
    const joins = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const join of catalog.relationships) {
        if (
          join.targetUnique &&
          reachable.has(join.from) &&
          !reachable.has(join.to) &&
          catalog.objects.some((o) => o.id === join.to)
        ) {
          reachable.add(join.to);
          joins.push(join.id);
          changed = true;
        }
      }
    }
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
