// Repair names only; never change filter fields, predicates or required flags.
export function normalizeFilterParameters(tool) {
  const reserved = new Set(tool.filters.map(filter => filter.parameter));
  const used = new Set();
  const filters = tool.filters.map(filter => {
    let parameter = filter.parameter;
    if (used.has(parameter)) {
      let suffix = 2;
      do {
        const ending = `_${suffix++}`;
        parameter = `${filter.parameter.slice(0, 63 - ending.length)}${ending}`;
      } while (reserved.has(parameter) || used.has(parameter));
    }
    used.add(parameter);
    return { ...filter, parameter };
  });
  return { ...tool, filters };
}
