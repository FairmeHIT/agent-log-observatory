// Shared helper: run a PowerShell fragment without capturing a pipe.
//
// Why: on Windows sandbox runs, `execFile` with piped stdio to capture stdout
// fails with EPERM (named-pipe capture is the documented sandbox boundary).
// Instead we spawn PowerShell with stdio redirected to files on disk and read
// the result back. stderr goes to its own file for diagnostics.
//
// The script writes its result to the path in $env:OBS_PS_OUT using
// `Out-File -Encoding utf8`, which is encoding-stable (Windows PowerShell 5.1
// may otherwise emit ANSI/UTF-16 when its stdout is redirected to a file).
//
// Also note: `Get-CimInstance Win32_Process` returns "Access denied"
// (HRESULT 0x80041003) under the sandbox token, so callers must use
// `Get-Process` (the .NET path) rather than WMI for process enumeration.

import { spawn } from "node:child_process";
import { tempPath } from "./runtime-paths.mjs";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";

let seq = 0;

/**
 * Run a PowerShell fragment whose result is written to $env:OBS_PS_OUT.
 * @param {string} script PowerShell code that writes its result via
 *   `Out-File -LiteralPath $env:OBS_PS_OUT -Encoding utf8`.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 *   `stdout` is the decoded contents of $env:OBS_PS_OUT.
 */
export async function runPowerShell(script, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const tag = `${process.pid}-${seq++}-${Date.now()}`;
  const outFile = tempPath(`obs-ps-${tag}.out`);
  const errFile = tempPath(`obs-ps-${tag}.err`);
  let errFd = null;
  try {
    errFd = fs.openSync(errFile, "w");
    const code = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
          stdio: ["ignore", "ignore", errFd],
          windowsHide: true,
          env: { ...process.env, OBS_PS_OUT: outFile },
        });
      } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    fs.closeSync(errFd); errFd = null;
    const stdout = await fsp.readFile(outFile, "utf8").catch(() => "");
    const stderr = await fsp.readFile(errFile, "utf8").catch(() => "");
    return { stdout, stderr, code };
  } finally {
    if (errFd != null) { try { fs.closeSync(errFd); } catch {} }
    try { await fsp.unlink(outFile); } catch {}
    try { await fsp.unlink(errFile); } catch {}
  }
}

/** Strip a UTF-8 BOM that `Out-File -Encoding utf8` may prepend. */
export function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
