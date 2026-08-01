import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ref = new URL(process.env.SUPABASE_URL!).hostname.split(".")[0];
const password = process.env.SUPABASE_DB_PASSWORD;

// Prefer an explicit connection string; otherwise try direct, then the IPv4 poolers.
const candidates = process.env.SUPABASE_DB_URL
  ? [process.env.SUPABASE_DB_URL]
  : [
      `postgresql://postgres:${encodeURIComponent(password!)}@db.${ref}.supabase.co:5432/postgres`,
      ...["aws-0", "aws-1"].flatMap((prefix) =>
        ["us-west-2", "us-east-1", "us-east-2", "us-west-1"].map(
          (r) =>
            `postgresql://postgres.${ref}:${encodeURIComponent(password!)}@${prefix}-${r}.pooler.supabase.com:5432/postgres`,
        ),
      ),
    ];

if (!process.env.SUPABASE_DB_URL && !password) {
  console.error("Set SUPABASE_DB_PASSWORD or SUPABASE_DB_URL in .env");
  process.exit(1);
}

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
const migrations = readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort();

let lastError: unknown;
for (const conn of candidates) {
  const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });

  try {
    await client.connect();
  } catch (err) {
    lastError = err;
    await client.end().catch(() => {});
    console.log(`(connection via ${new URL(conn.replace("postgresql://", "http://")).hostname} failed, trying next)`);
    continue;
  }

  // Connected. Anything that fails from here is a problem with the SQL, not the host —
  // reported as such rather than swallowed and retried against the next pooler, which
  // is how a broken migration used to masquerade as "all connection attempts failed".
  let current = "";
  try {
    for (const file of migrations) {
      current = file;
      console.log(`Running ${file}...`);
      await client.query(readFileSync(join(sqlDir, file), "utf8"));
    }
    console.log("✅ Migrations applied.");
    await client.end();
    process.exit(0);
  } catch (err) {
    const e = err as { message?: string; code?: string; detail?: string; hint?: string; position?: string };
    console.error(`\n❌ ${current} failed — ${e.code ?? "error"}: ${e.message}`);
    if (e.detail) console.error(`   detail: ${e.detail}`);
    if (e.hint) console.error(`   hint:   ${e.hint}`);
    if (e.position) {
      const sql = readFileSync(join(sqlDir, current), "utf8");
      const lineNo = sql.slice(0, Number(e.position)).split("\n").length;
      const lines = sql.split("\n");
      console.error(`   at line ${lineNo}:`);
      for (let i = Math.max(0, lineNo - 3); i < Math.min(lines.length, lineNo + 2); i++) {
        console.error(`   ${i + 1 === lineNo ? "→" : " "} ${String(i + 1).padStart(4)}  ${lines[i]}`);
      }
    }
    await client.end().catch(() => {});
    process.exit(1);
  }
}

console.error("All connection attempts failed. Last error:", lastError);
process.exit(1);
