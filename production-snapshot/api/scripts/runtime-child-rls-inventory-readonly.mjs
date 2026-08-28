import fs from "node:fs";
import pg from "pg";

const connectionString = process.env.DATABASE_URL || fs.readFileSync(
  process.env.DATABASE_URL_FILE || "/run/secrets/database_url",
  "utf8",
).trim();

const pool = new pg.Pool({
  connectionString,
  max: 1,
  options: "-c default_transaction_read_only=on -c statement_timeout=60000",
});

const safeIdentifier = (value) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("unsafe_catalog_identifier");
  return `"${value}"`;
};

try {
  const catalog = await pool.query(`
    WITH runtime_tables AS (
      SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name,
        c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='tender' AND c.relkind='r'
        AND (
          has_table_privilege('tender_api_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR
          has_table_privilege('tender_worker_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR
          has_table_privilege('tender_scheduler_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE')
        )
    ), single_column_fks AS (
      SELECT con.conrelid, con.confrelid,
        child_attribute.attname AS child_column,
        parent_attribute.attname AS parent_column
      FROM pg_constraint con
      JOIN pg_attribute child_attribute
        ON child_attribute.attrelid=con.conrelid AND child_attribute.attnum=con.conkey[1]
      JOIN pg_attribute parent_attribute
        ON parent_attribute.attrelid=con.confrelid AND parent_attribute.attnum=con.confkey[1]
      WHERE con.contype='f' AND array_length(con.conkey,1)=1
    )
    SELECT child.table_name, fk.child_column,
      parent_namespace.nspname AS parent_schema, parent.relname AS parent_table,
      fk.parent_column, column_info.is_nullable,
      child.relrowsecurity AS child_rls, child.relforcerowsecurity AS child_force_rls,
      parent.relrowsecurity AS parent_rls, parent.relforcerowsecurity AS parent_force_rls
    FROM runtime_tables child
    JOIN single_column_fks fk ON fk.conrelid=child.oid
    JOIN pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid=parent.relnamespace
    JOIN information_schema.columns column_info
      ON column_info.table_schema=child.schema_name
      AND column_info.table_name=child.table_name
      AND column_info.column_name=fk.child_column
    WHERE parent.relrowsecurity AND NOT child.relrowsecurity
    ORDER BY child.table_name,fk.child_column,parent_namespace.nspname,parent.relname
  `);

  const rows=[];
  for (const relation of catalog.rows) {
    const table=safeIdentifier(relation.table_name);
    const column=safeIdentifier(relation.child_column);
    const counts=await pool.query(
      `SELECT count(*)::bigint AS row_count, count(*) FILTER(WHERE ${column} IS NULL)::bigint AS null_fk_count FROM tender.${table}`,
    );
    rows.push({
      ...relation,
      row_count:Number(counts.rows[0].row_count),
      null_fk_count:Number(counts.rows[0].null_fk_count),
    });
  }

  process.stdout.write(`${JSON.stringify({
    generatedAt:new Date().toISOString(),
    readOnly:true,
    externalWrite:false,
    relationCount:rows.length,
    relations:rows,
  },null,2)}\n`);
} finally {
  await pool.end();
}
