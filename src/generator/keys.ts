import { singleQuoted } from './strings.ts'

// R41: a name with no `_` is kept exactly. Otherwise leading and trailing underscores are
// kept, and in between each run of `_` is removed and the character after it upper-cased.
export function camelCase(name: string): string {
  if (!name.includes('_')) return name
  const match = /^(_*)(.*?)(_*)$/su.exec(name)
  if (match === null) return name
  const [, leading = '', middle = '', trailing = ''] = match
  return leading + middle.replace(/_+(.)/gsu, (_, next: string) => next.toUpperCase()) + trailing
}

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u

// R42: a valid identifier is written bare, and any other key as a single-quoted string.
export function propertyName(key: string): string {
  return IDENTIFIER.test(key) ? key : singleQuoted(key)
}

// `params.k`, or `params['k']` for a key that must be quoted (R34).
export function propertyAccess(object: string, key: string): string {
  return IDENTIFIER.test(key) ? `${object}.${key}` : `${object}[${singleQuoted(key)}]`
}

export function isIdentifier(text: string): boolean {
  return IDENTIFIER.test(text)
}
