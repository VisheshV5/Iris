import "dotenv/config";
import pg from "pg";
const hosts = ["aws-0-us-west-2", "aws-1-us-west-2", "aws-0-us-east-1", "aws-1-us-east-1", "aws-0-us-west-1"];
for (const h of hosts) {
  const c = new pg.Client({
    connectionString: `postgresql://postgres.wacgfjfhneiidbpxhgqt:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD!)}@${h}.pooler.supabase.com:5432/postgres`,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 6000,
  });
  try {
    await c.connect();
    const r = await c.query(
      `select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
       from information_schema.role_table_grants
       where table_name in ('calls','kb_escalations') and grantee in ('anon','authenticated')
       group by table_name, grantee order by table_name, grantee`,
    );
    for (const row of r.rows) console.log(`${row.table_name} / ${row.grantee}: ${row.privs}`);
    await c.end();
    process.exit(0);
  } catch {
    await c.end().catch(() => {});
  }
}
console.error("no pooler reachable");
