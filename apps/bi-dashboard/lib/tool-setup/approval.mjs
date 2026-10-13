// Approval only updates registry state; testing and data execution are optional.
export async function updateApprovals(db, tools, approved) {
  await db.beginTransaction();
  try {
    for (const tool of tools) {
      const [result] = await db.execute(
        "UPDATE bi_generated_tools SET status=?,approved_at=IF(?='approved',NOW(),NULL) WHERE id=? AND version=? AND definition_json=? AND catalog_fingerprint=?",
        [approved ? 'approved' : 'draft', approved ? 'approved' : 'draft', tool.id, tool.version, JSON.stringify(tool.definition), tool.catalog_fingerprint],
      );
      if (!result.affectedRows) throw new Error('Tool changed. Refresh the registry and try again.');
    }
    await db.commit();
    return { updated: tools.length, approved };
  } catch (error) {
    await db.rollback();
    throw error;
  }
}
