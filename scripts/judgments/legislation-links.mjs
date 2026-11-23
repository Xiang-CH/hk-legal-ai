const tables=[{table:'_JudgmentToLegislationCap',column:'cap_id'},{table:'_JudgmentToLegislationSection',column:'section_id'}];

/** Remove only importer-owned legislation links, preserving relationships that existed before ingestion. */
export async function clearManagedLinks(client,sourceId) {
 for(const {table,column} of tables)await client.query(`DELETE FROM "${table}" links USING judgment_managed_legislation_links owned WHERE owned.source_id=$1 AND owned.${column}=links."B" AND links."A"=owned.source_id`,[sourceId]);
 await client.query('DELETE FROM judgment_managed_legislation_links WHERE source_id=$1',[sourceId]);
}

/** Reconcile resolved legislation references with tracked links without taking ownership of pre-existing relationships. */
export async function syncManagedLinks(client,sourceId) {
 for(const {table,column} of tables) {
  const desired=(await client.query(`SELECT DISTINCT ${column} AS target FROM judgment_legislation_references WHERE source_id=$1 AND status='resolved' AND ${column} IS NOT NULL`,[sourceId])).rows.map(row=>row.target);
  await client.query(`DELETE FROM "${table}" links USING judgment_managed_legislation_links owned WHERE owned.source_id=$1 AND owned.${column}=links."B" AND links."A"=owned.source_id AND NOT(owned.${column}=ANY($2::int[]))`,[sourceId,desired]);
  await client.query(`DELETE FROM judgment_managed_legislation_links WHERE source_id=$1 AND ${column} IS NOT NULL AND NOT(${column}=ANY($2::int[]))`,[sourceId,desired]);
  for(const target of desired) {
   const inserted=await client.query(`INSERT INTO "${table}"("A","B") VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING "A"`,[sourceId,target]);
   if(inserted.rowCount)await client.query(`INSERT INTO judgment_managed_legislation_links(source_id,${column}) VALUES($1,$2) ON CONFLICT DO NOTHING`,[sourceId,target]);
  }
 }
}
