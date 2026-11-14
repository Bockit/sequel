import { scan, type Token } from './lexer.ts'

// R68: sqlc's own parameter syntax left in `Query.text`. sqlc rewrites `@name` and the
// `sqlc.*` functions into `$n`, but drops that rewrite when it can't analyse a query
// (Appendix A), and Postgres would then read `@name` as its `@` operator.

const SQLC_FUNCTIONS = new Set(['ARG', 'NARG', 'SLICE', 'EMBED'])

// Each leftover as written (`@name`, `sqlc.arg(name)`), once, in the order of the text.
// Strings, quoted identifiers and comments are skipped by the lexer. sqlc reads any `@`
// followed by a name as a parameter, binary or prefix, so this does too.
export function unboundParameters(text: string): string[] {
  const { tokens } = scan(text)
  const found: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    let written: string | null = null
    if (token.kind === 'op' && token.text === '@' && isName(tokens[i + 1])) {
      written = `@${shown(tokens[i + 1] as Token)}`
    } else if (
      token.kind === 'word' &&
      token.upper === 'SQLC' &&
      isPunct(tokens[i + 1], '.') &&
      tokens[i + 2]?.kind === 'word' &&
      SQLC_FUNCTIONS.has((tokens[i + 2] as Token).upper) &&
      isPunct(tokens[i + 3], '(')
    ) {
      const argument = tokens[i + 4]
      const single = isName(argument) && isPunct(tokens[i + 5], ')')
      const inner = single ? shown(argument as Token) : '…'
      written = `sqlc.${(tokens[i + 2] as Token).text.toLowerCase()}(${inner})`
    }
    if (written !== null && !found.includes(written)) found.push(written)
  }
  return found
}

function isName(token: Token | undefined): boolean {
  return token !== undefined && (token.kind === 'word' || token.kind === 'qident')
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === text
}

function shown(token: Token): string {
  return token.kind === 'qident' ? `"${token.text.replaceAll('"', '""')}"` : token.text
}
