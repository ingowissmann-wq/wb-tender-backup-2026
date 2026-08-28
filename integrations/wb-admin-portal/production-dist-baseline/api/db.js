import pg from "pg";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, statement_timeout: 10000 });
export async function query(text, values = []) { return pool.query(text, values); }
