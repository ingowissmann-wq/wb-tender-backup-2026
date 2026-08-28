import pg from "pg";
import { readFileSync } from "node:fs";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").toString().trim();
const pool = new pg.Pool({ connectionString, max: 1 });

const query = `
select table_schema, table_name,
       jsonb_agg(column_name order by ordinal_position) as columns
from information_schema.columns
where table_schema in ('tender','iam')
  and (table_name ~ '(tender|source|portal|document|enrichment|calculation|management|approval|bid|job|lease|region)' or table_name in ('autopilot_queue','lots'))
group by table_schema, table_name
order by table_schema, table_name`;

try {
  const result = await pool.query(query);
  for (const row of result.rows) console.log(`${row.table_schema}.${row.table_name}|${JSON.stringify(row.columns)}`);
} finally {
  await pool.end();
}
