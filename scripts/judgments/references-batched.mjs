/** Persist prepared reference evidence for a bounded group, preserving source generations and ownership of legacy links. */
export async function writeReferenceBatch(client,entries){
 if(!entries.length)return;
 const ids=entries.map(e=>e.sourceId).sort((a,b)=>a-b);
 await client.query('BEGIN');
 try{
  await client.query('SELECT id FROM "Judgment" WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[ids]);
  const current=new Map((await client.query('SELECT id,generation::text FROM judgment_documents WHERE judgment_id=ANY($1::int[])',[ids])).rows.map(r=>[String(r.id),r.generation]));
  if(entries.some(e=>current.get(String(e.documentId))!==String(e.generation)))throw Error('Reference source generation changed; retry batch');
  await client.query('DELETE FROM judgment_references WHERE source_id=ANY($1::int[])',[ids]);
  await client.query('DELETE FROM judgment_legislation_references WHERE source_id=ANY($1::int[])',[ids]);
  const references=entries.flatMap(e=>e.references);
  const key=(source,kind,normalized)=>JSON.stringify([source,kind,normalized]);
  if(references.length){
   const inserted=(await client.query(`INSERT INTO judgment_references(source_id,kind,original,normalized,status,target_id,candidates,provenance,resolver_version)
    SELECT source_id,kind,original,normalized,status,target_id,candidates,provenance,resolver_version FROM jsonb_to_recordset($1::jsonb) AS r(source_id int,kind text,original text,normalized text,status text,target_id int,candidates jsonb,provenance jsonb,resolver_version text) RETURNING id,source_id,kind,normalized`,[JSON.stringify(references)])).rows;
   const mapping=new Map(inserted.map(r=>[key(r.source_id,r.kind,r.normalized),r.id]));
   const occurrences=entries.flatMap(e=>e.occurrences.map(({identity,...row})=>{const [kind,normalized]=JSON.parse(identity);return {...row,reference_id:mapping.get(key(e.sourceId,kind,normalized))};}));
   await client.query(`INSERT INTO judgment_reference_occurrences(reference_id,evidence_key,paragraph_id,anchor,evidence) SELECT reference_id,evidence_key,paragraph_id,anchor,evidence FROM jsonb_to_recordset($1::jsonb) AS r(reference_id bigint,evidence_key text,paragraph_id bigint,anchor text,evidence jsonb)`,[JSON.stringify(occurrences)]);
  }
  const legislation=entries.flatMap(e=>e.legislation);
  if(legislation.length)await client.query(`INSERT INTO judgment_legislation_references(source_id,original,normalized,status,cap_id,section_id,candidates,provenance) SELECT source_id,original,normalized,status,cap_id,section_id,candidates,provenance FROM jsonb_to_recordset($1::jsonb) AS r(source_id int,original text,normalized text,status text,cap_id int,section_id int,candidates jsonb,provenance jsonb)`,[JSON.stringify(legislation)]);
  for(const {table,column} of [{table:'_JudgmentToLegislationCap',column:'cap_id'},{table:'_JudgmentToLegislationSection',column:'section_id'}]){
   await client.query(`DELETE FROM "${table}" l USING judgment_managed_legislation_links o WHERE o.source_id=ANY($1::int[]) AND o.source_id=l."A" AND o.${column}=l."B" AND NOT EXISTS(SELECT 1 FROM judgment_legislation_references r WHERE r.source_id=o.source_id AND r.${column}=o.${column} AND r.status='resolved')`,[ids]);
   await client.query(`DELETE FROM judgment_managed_legislation_links o WHERE o.source_id=ANY($1::int[]) AND o.${column} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judgment_legislation_references r WHERE r.source_id=o.source_id AND r.${column}=o.${column} AND r.status='resolved')`,[ids]);
   await client.query(`WITH inserted AS (INSERT INTO "${table}"("A","B") SELECT DISTINCT source_id,${column} FROM judgment_legislation_references WHERE source_id=ANY($1::int[]) AND status='resolved' AND ${column} IS NOT NULL ON CONFLICT DO NOTHING RETURNING "A","B") INSERT INTO judgment_managed_legislation_links(source_id,${column}) SELECT "A","B" FROM inserted ON CONFLICT DO NOTHING`,[ids]);
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
}
