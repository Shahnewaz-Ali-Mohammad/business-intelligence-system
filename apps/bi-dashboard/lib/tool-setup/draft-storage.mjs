import {reportFingerprint,reportCovers} from './report-identity.mjs';
import crypto from 'node:crypto';
import {fingerprint} from './model.mjs';

// What a tool actually does, ignoring its name and wording. Two tools with
// the same behaviour fingerprint return the same data.
export const behaviourFingerprint = reportFingerprint;

/**
 * Saves one generation run's tools for a database.
 *
 * - A new tool that does exactly what an existing tool already does (even
 *   under a different name) is skipped.
 * - Approved tools are never changed or removed.
 * - Unapproved drafts from earlier runs that this run did not produce again
 *   are removed, so regenerating replaces the previous drafts instead of
 *   piling up new ones.
 *
 * Returns { added, updated, unchanged, removed }.
 */
export async function saveDraftDefinitions(connection, sourceId, catalogFingerprint, definitions, { additive = false } = {}) {
  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  try {
    await connection.beginTransaction();
    const [sources] = await connection.execute(
      "SELECT catalog_fingerprint FROM bi_tool_sources WHERE id=? FOR UPDATE",
      [sourceId],
    );
    if (sources[0]?.catalog_fingerprint !== catalogFingerprint)
      throw new Error("Catalog changed while drafting. Reload and generate again.");

    const [existingRows] = await connection.execute(
      "SELECT id,name,status,definition_json,catalog_fingerprint FROM bi_generated_tools WHERE source_id=? FOR UPDATE",
      [sourceId],
    );
    const existing = existingRows.map(row=>({...row,definition:JSON.parse(row.definition_json)}));
    const kept = new Set();
    const seenThisRun = [];

    for (let definition of definitions) {
      // Duplicates inside the same run.
      if (seenThisRun.some(t=>reportCovers(t,definition))) { counts.unchanged += 1; continue; }
      seenThisRun.push(definition);

      // Same behaviour already saved for this schema: keep the existing tool.
      const sameBehaviour = existing.find((t) => t.catalog_fingerprint === catalogFingerprint && reportCovers(t.definition,definition));
      if (sameBehaviour) { kept.add(sameBehaviour.id); counts.unchanged += 1; continue; }

      // A new suggestion never silently replaces an approved tool of the same name.
      let current = existing.find((t) => t.name === definition.name);
      if (current?.status === "approved") {
        kept.add(current.id);
        definition = { ...definition, name: `${definition.name.slice(0, 45)}_draft_${fingerprint(definition).slice(0, 10)}` };
        current = existing.find((t) => t.name === definition.name);
        if (current?.status === 'approved') { kept.add(current.id); counts.unchanged += 1; continue; }
      }

      await connection.execute(
        "INSERT INTO bi_generated_tools(id,source_id,name,definition_json,catalog_fingerprint) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE definition_json=VALUES(definition_json),catalog_fingerprint=VALUES(catalog_fingerprint),status='draft',version=version+1,tested_hash=NULL,tested_at=NULL,approved_at=NULL",
        [crypto.randomUUID(), sourceId, definition.name, JSON.stringify(definition), catalogFingerprint],
      );
      await connection.execute(
        "INSERT INTO bi_tool_versions(tool_id,version,definition_json,catalog_fingerprint) SELECT id,version,definition_json,catalog_fingerprint FROM bi_generated_tools WHERE source_id=? AND name=?",
        [sourceId, definition.name],
      );
      if (current) { kept.add(current.id); counts.updated += 1; } else counts.added += 1;
    }

    // Remove earlier unapproved drafts this run did not produce again.
    const stale = additive ? [] : existing.filter((t) => t.status !== 'approved' && !kept.has(t.id));
    for (const tool of stale) {
      await connection.execute("DELETE FROM bi_generated_tools WHERE id=? AND status<>'approved'", [tool.id]);
    }
    counts.removed = stale.length;

    await connection.commit();
    return counts;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
