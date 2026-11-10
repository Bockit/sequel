// R53: every string literal except the SQL text is single-quoted.
export function singleQuoted(value: string): string {
  let out = "'"
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') out += '\\\\'
    else if (char === "'") out += "\\'"
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (code === 0x2028) out += '\\u2028'
    else if (code === 0x2029) out += '\\u2029'
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += char
  }
  return `${out}'`
}

// R25: the SQL text as a template literal whose cooked value is `text`. Line feeds stay
// literal, so the SQL reads as written; a carriage return is escaped so CRLF survives.
export function templateLiteral(text: string): string {
  const body = text
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
    .replaceAll('\r', '\\r')
  return `\`${body}\``
}
