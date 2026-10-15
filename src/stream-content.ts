/** Read only the top-level JSON content string, including incomplete safe prefixes.
 * Never expose envelope keys, tool arguments or incomplete escape sequences. */
export function publicContent(raw: string): string | null {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') { depth--; continue; }
    if (c !== '"') continue;
    const start = i++; let escaped = false;
    for (; i < raw.length; i++) {
      if (!escaped && raw[i] === '"') break;
      if (!escaped && raw[i] === '\\') escaped = true; else escaped = false;
    }
    if (i >= raw.length) return null;
    if (depth !== 1 || raw.slice(start, i + 1) !== '"content"') continue;
    let p = i + 1; while (/\s/.test(raw[p] ?? '') && p < raw.length) p++;
    if (raw[p++] !== ':') continue;
    while (p < raw.length && /\s/.test(raw[p]!)) p++;
    if (raw[p++] !== '"') return null;
    let text = '';
    for (; p < raw.length; p++) {
      const ch = raw[p]!;
      if (ch === '"') return text;
      if (ch === '\\') {
        const e = raw[++p];
        if (!e) return safeEnd(text);
        if (e === 'u') {
          const hex = raw.slice(p + 1, p + 5); if (!/^[a-f0-9]{4}$/i.test(hex)) return safeEnd(text);
          text += String.fromCharCode(parseInt(hex, 16)); p += 4;
        } else {
          const escapes: Record<string, string> = {'"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t'};
          if (!(e in escapes)) return null; text += escapes[e];
        }
      } else { if (ch.charCodeAt(0) < 32) return null; text += ch; }
    }
    return safeEnd(text);
  }
  return null;
}
function safeEnd(text: string) { return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text; }

/** Delay a suffix that could still become a known credential on the next update. */
export function withoutSecretPrefix(text:string, secrets:string[]) {
  let hold = 0;
  for (const secret of secrets) {
    if (!secret || text.endsWith(secret)) continue;
    const limit = Math.min(secret.length - 1,text.length);
    for (let n=limit;n>hold;n--) if (text.endsWith(secret.slice(0,n))) {hold=n;break;}
  }
  return hold ? text.slice(0,-hold) : text;
}
