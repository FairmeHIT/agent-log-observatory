// Shared SQLite query helper for adapters.
//
// Why this exists: adapters previously called runtime/sqlite3.exe via
// `execFile` with piped stdio to capture JSON output. On Windows sandbox
// runs that spawn path fails with EPERM (named-pipe stdio capture is the
// documented sandbox boundary). This helper keeps the portable
// sqlite3.exe design but writes results to a temp file via sqlite3's
// `.output` dot-command using `stdio: 'ignore'` (an allowed spawn shape),
// then reads the file back. No native module, no captured pipe.
//
// Output strategy: JSON first; on JSON parse failure (sqlite3 CLI does
// not always escape CJK full-width quotes and other characters reliably),
// fall back to `.mode list` with a NUL-free separator and parse rows by
// the column order taken from the SELECT clause. The list fallback is
// robust for any text because it never goes through JSON escaping.

import { spawn } from "node:child_process";
import { tempPath } from "./runtime-paths.mjs";
import path from "node:path";
import fsSync from "node:fs";
import fs from "node:fs/promises";

let seq = 0;
const SEP = "\x1f"; // ASCII unit separator, never appears in normal text/JSON

function tempFile() {
  return tempPath(`dsh-sql-${process.pid}-${seq++}-${Date.now()}.json`);
}

function runSpawn(sqliteExe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(sqliteExe, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function columnsFromSelect(sql) {
  // Extract column names from "SELECT a, b AS c, ... FROM".
  const m = sql.match(/SELECT\s+(.+?)\s+FROM/is);
  if (!m) return [];
  return m[1].split(",").map((p) => {
    p = p.trim();
    // "expr AS alias" or "table.col" -> take the last identifier
    const asMatch = p.match(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
    if (asMatch) return asMatch[1];
    const dot = p.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    return dot ? dot[1] : p;
  });
}

function coerce(v) {
  if (v === null || v === undefined) return null;
  if (v === "") return null;
  // Numeric coercion so downstream epoch/arithmetic sees numbers, not strings.
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

export async function querySqlite(sqliteExe, dbPath, sql) {
  if (!sqliteExe || !dbPath || !sql) return [];
  const outFile = tempFile();
  try {
    // Try JSON mode first.
    await runSpawn(sqliteExe, ["-readonly", dbPath, ".mode json", `.output "${outFile.replace(/\\/g, "/")}"`, sql, ".output stdout"]);
    const text = await fs.readFile(outFile, "utf8");
    try { return JSON.parse(text) || []; } catch {
      // JSON parse failed (special chars sqlite3 did not escape).
      // Fall back to list mode with a separator.
      await fs.unlink(outFile).catch(() => {});
      await runSpawn(sqliteExe, ["-readonly", dbPath, ".mode list", ".headers off", `.separator ${SEP}`, `.output "${outFile.replace(/\\/g, "/")}"`, sql, ".output stdout"]);
      const raw = await fs.readFile(outFile, "utf8");
      const cols = columnsFromSelect(sql);
      const rows = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line === "") continue;
        const parts = line.split(SEP);
        const obj = {};
        cols.forEach((c, i) => { obj[c] = coerce(parts[i] ?? null); });
        rows.push(obj);
      }
      return rows;
    }
  } catch {
    return [];
  } finally {
    try { fsSync.existsSync(outFile) && await fs.unlink(outFile); } catch {}
  }
}
