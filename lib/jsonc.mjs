// Parse JSON with comments/trailing commas without altering string contents.
export function parseJsonc(text) {
  let out = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quoted) { out += c; if (c === "\\") out += text[++i] || ""; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; out += c; continue; }
    if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; out += " "; continue; }
    out += c;
  }
  let clean = ""; quoted = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quoted) { clean += c; if (c === "\\") clean += out[++i] || ""; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if (c === "," && /^[\s]*[}\]]/.test(out.slice(i + 1))) continue;
    clean += c;
  }
  return JSON.parse(clean);
}
