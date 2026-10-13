"use client";

import { useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import type { Catalog, ToolDefinition } from "@/lib/tool-setup/store";

const input =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm";
const icon = "rounded-md border border-zinc-200 p-2 disabled:opacity-40";
export function ToolPlanEditor({
  initial,
  catalog,
  busy,
  onSave,
}: {
  initial: ToolDefinition;
  catalog: Catalog;
  busy: boolean;
  onSave: (definition: ToolDefinition) => void;
}) {
  const [tool, setTool] = useState(initial);
  const base = catalog.objects.find((o) => o.id === tool.base);
  const included = new Set([
    tool.base,
    ...tool.joins.map(
      (id) => catalog.relationships.find((j) => j.id === id)?.to,
    ),
  ]);
  const fields = catalog.objects
    .filter((o) => included.has(o.id))
    .flatMap((o) =>
      o.columns
        .filter((c) => !c.restricted)
        .map((c) => ({
          id: `${o.id}:${c.name}`,
          label: `${o.name} · ${c.name}`,
          numeric:
            /^(?:tinyint|smallint|int|integer|bigint|decimal|numeric|real|float|double|money|smallmoney)(?:\b|$)/i.test(
              c.dataType,
            ),
        })),
    );
  const toggle = (values: string[], value: string) =>
    values.includes(value)
      ? values.filter((v) => v !== value)
      : [...values, value];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(tool);
      }}
      className="space-y-5"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          Tool name
          <input
            required
            pattern="[a-z][a-z0-9_]{2,63}"
            maxLength={64}
            className={input}
            value={tool.name}
            onChange={(e) => setTool({ ...tool, name: e.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          Result type
          <select
            className={input}
            value={tool.mode}
            onChange={(e) =>
              setTool({
                ...tool,
                mode: e.target.value as ToolDefinition["mode"],
                columns:
                  e.target.value === "rows"
                    ? base?.columns
                        .slice(0, 5)
                        .map((c) => `${base.id}:${c.name}`) || []
                    : [],
                groupBy: [],
                metrics:
                  e.target.value === "aggregate"
                    ? [
                        {
                          field: null,
                          operation: "count",
                          alias: "record_count",
                        },
                      ]
                    : [],
              })
            }
          >
            <option value="rows">Individual records</option>
            <option value="aggregate">Summary / grouped totals</option>
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        Description
        <textarea
          required
          minLength={10}
          maxLength={1500}
          className={input}
          value={tool.description}
          onChange={(e) => setTool({ ...tool, description: e.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm">
        Main table / view
        <select
          className={input}
          value={tool.base}
          onChange={(e) => {
            const next = catalog.objects.find((o) => o.id === e.target.value)!;
            setTool({
              ...tool,
              base: next.id,
              joins: [],
              filters: [],
              columns:
                tool.mode === "rows"
                  ? next.columns
                      .filter((c) => !c.restricted)
                      .slice(0, 5)
                      .map((c) => `${next.id}:${c.name}`)
                  : [],
              groupBy: [],
              metrics:
                tool.mode === "aggregate"
                  ? [{ field: null, operation: "count", alias: "record_count" }]
                  : [],
            });
          }}
        >
          {catalog.objects
            .filter((o) => o.kind !== "procedure")
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.id}
              </option>
            ))}
        </select>
      </label>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Relationships</legend>
        <div className="space-y-2">
          {catalog.relationships
            .filter((j) => j.targetUnique && included.has(j.from))
            .map((j) => (
              <label key={j.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={tool.joins.includes(j.id)}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      joins: e.target.checked ? [...tool.joins, j.id] : [],
                      columns: tool.columns.filter((c) =>
                        c.startsWith(`${tool.base}:`),
                      ),
                      groupBy: [],
                      filters: [],
                      metrics:
                        tool.mode === "aggregate"
                          ? [
                              {
                                field: null,
                                operation: "count",
                                alias: "record_count",
                              },
                            ]
                          : [],
                    })
                  }
                />
                {j.from} → {j.to}
              </label>
            ))}
          {!catalog.relationships.some(
            (j) => j.targetUnique && included.has(j.from),
          ) && (
            <p className="text-xs text-zinc-500">
              No verified relationships available.
            </p>
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">
          {tool.mode === "rows" ? "Returned columns" : "Group by"}
        </legend>
        <div className="grid max-h-44 gap-2 overflow-y-auto sm:grid-cols-2">
          {fields.map((f) => (
            <label key={f.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={(tool.mode === "rows"
                  ? tool.columns
                  : tool.groupBy
                ).includes(f.id)}
                onChange={() =>
                  setTool(
                    tool.mode === "rows"
                      ? { ...tool, columns: toggle(tool.columns, f.id) }
                      : { ...tool, groupBy: toggle(tool.groupBy, f.id) },
                  )
                }
              />
              <span className="break-all">{f.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {tool.mode === "aggregate" && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Metrics</legend>
          <div className="space-y-2">
            {tool.metrics.map((m, index) => (
              <div
                key={index}
                className="grid gap-2 sm:grid-cols-[1fr_2fr_1fr_auto]"
              >
                <select
                  aria-label={`Metric ${index + 1} operation`}
                  className={input}
                  value={m.operation}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      metrics: tool.metrics.map((v, i) =>
                        i === index
                          ? {
                              ...v,
                              operation: e.target.value as typeof m.operation,
                              field:
                                e.target.value === "count"
                                  ? null
                                  : fields.find((f) => f.numeric)?.id || null,
                            }
                          : v,
                      ),
                    })
                  }
                >
                  {["count", "sum", "avg", "min", "max"].map((op) => (
                    <option key={op} value={op}>
                      {
                        (
                          {
                            count: "Count",
                            sum: "Total",
                            avg: "Average",
                            min: "Lowest",
                            max: "Highest",
                          } as Record<string, string>
                        )[op]
                      }
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Metric ${index + 1} field`}
                  className={input}
                  value={m.field || ""}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      metrics: tool.metrics.map((v, i) =>
                        i === index
                          ? { ...v, field: e.target.value || null }
                          : v,
                      ),
                    })
                  }
                >
                  {m.operation === "count" && (
                    <option value="">All records</option>
                  )}
                  {fields
                    .filter((f) => m.operation === "count" || f.numeric)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                </select>
                <input
                  aria-label={`Metric ${index + 1} output name`}
                  required
                  className={input}
                  value={m.alias}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      metrics: tool.metrics.map((v, i) =>
                        i === index ? { ...v, alias: e.target.value } : v,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  title="Remove metric"
                  className={icon}
                  onClick={() =>
                    setTool({
                      ...tool,
                      metrics: tool.metrics.filter((_, i) => i !== index),
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={tool.metrics.length >= 8}
            className={`${icon} mt-2`}
            title="Add metric"
            onClick={() =>
              setTool({
                ...tool,
                metrics: [
                  ...tool.metrics,
                  {
                    field: null,
                    operation: "count",
                    alias: `record_count_${tool.metrics.length + 1}`,
                  },
                ],
              })
            }
          >
            <Plus size={16} />
          </button>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Filters</legend>
        <div className="space-y-2">
          {tool.filters.map((f, index) => (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto_auto]"
            >
              <select
                aria-label={`Filter ${index + 1} column`}
                className={input}
                value={f.field}
                onChange={(e) =>
                  setTool({
                    ...tool,
                    filters: tool.filters.map((v, i) =>
                      i === index ? { ...v, field: e.target.value } : v,
                    ),
                  })
                }
              >
                {fields.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Filter ${index + 1} condition`}
                className={input}
                value={f.operator}
                onChange={(e) =>
                  setTool({
                    ...tool,
                    filters: tool.filters.map((v, i) =>
                      i === index
                        ? {
                            ...v,
                            operator: e.target.value as typeof f.operator,
                          }
                        : v,
                    ),
                  })
                }
              >
                {Object.entries({
                  eq: "Equals",
                  ne: "Not equal",
                  gt: "Greater than",
                  gte: "At least",
                  lt: "Less than",
                  lte: "At most",
                  contains: "Contains",
                  is_null: "Is empty (NULL)",
                  not_null: "Is not empty (NOT NULL)",
                }).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Filter ${index + 1} parameter name`}
                className={input}
                value={f.parameter}
                onChange={(e) =>
                  setTool({
                    ...tool,
                    filters: tool.filters.map((v, i) =>
                      i === index ? { ...v, parameter: e.target.value } : v,
                    ),
                  })
                }
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  disabled={["is_null", "not_null"].includes(f.operator)}
                  checked={f.required}
                  onChange={(e) =>
                    setTool({
                      ...tool,
                      filters: tool.filters.map((v, i) =>
                        i === index ? { ...v, required: e.target.checked } : v,
                      ),
                    })
                  }
                />
                Required
              </label>
              <button
                type="button"
                title="Remove filter"
                className={icon}
                onClick={() =>
                  setTool({
                    ...tool,
                    filters: tool.filters.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          title="Add filter"
          disabled={tool.filters.length >= 12 || !fields.length}
          className={`${icon} mt-2`}
          onClick={() =>
            setTool({
              ...tool,
              filters: [
                ...tool.filters,
                {
                  field: fields[0].id,
                  operator: "eq",
                  parameter: `filter_${tool.filters.length + 1}`,
                  required: false,
                },
              ],
            })
          }
        >
          <Plus size={16} />
        </button>
      </fieldset>
      <button
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-800 disabled:opacity-40"
      >
        <Save size={16} />
        Save draft
      </button>
    </form>
  );
}
