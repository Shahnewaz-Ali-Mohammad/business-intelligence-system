import crypto from 'node:crypto';
import {fingerprint} from './model.mjs';

export async function saveDraftDefinitions(connection, sourceId, catalogFingerprint, definitions) {
  try {
    await connection.beginTransaction();
    const [sources] = await connection.execute(
      "SELECT catalog_fingerprint FROM bi_tool_sources WHERE id=? FOR UPDATE",
      [sourceId],
    );
    if (
      sources[0]?.catalog_fingerprint !==
      catalogFingerprint
    )
      throw new Error(
        "Catalog changed while drafting. Reload and generate again.",
      );
    for (let definition of definitions) {
      // A new suggestion never silently replaces an approved tool of the same name.
      const [rows] = await connection.execute(
        "SELECT id,status,definition_json,catalog_fingerprint FROM bi_generated_tools WHERE source_id=? AND name=? FOR UPDATE",
        [sourceId, definition.name],
      );
      const current = rows[0];
      if (current?.status === "approved") {
        const previous = JSON.parse(current.definition_json);
        if (current.catalog_fingerprint === catalogFingerprint && fingerprint(previous) === fingerprint(definition)) continue;
        // Changed suggestions are separate drafts; active tools remain unchanged.
        definition = { ...definition, name: `${definition.name.slice(0, 45)}_draft_${fingerprint(definition).slice(0, 10)}` };
        const [copies] = await connection.execute('SELECT status FROM bi_generated_tools WHERE source_id=? AND name=? FOR UPDATE', [sourceId, definition.name]);
        if (copies[0]?.status === 'approved') continue;
      }
      await connection.execute(
        "INSERT INTO bi_generated_tools(id,source_id,name,definition_json,catalog_fingerprint) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE definition_json=VALUES(definition_json),catalog_fingerprint=VALUES(catalog_fingerprint),status='draft',version=version+1,tested_hash=NULL,tested_at=NULL,approved_at=NULL",
        [
          crypto.randomUUID(),
          sourceId,
          definition.name,
          JSON.stringify(definition),
          catalogFingerprint,
        ],
      );
      await connection.execute(
        "INSERT INTO bi_tool_versions(tool_id,version,definition_json,catalog_fingerprint) SELECT id,version,definition_json,catalog_fingerprint FROM bi_generated_tools WHERE source_id=? AND name=?",
        [sourceId, definition.name],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
