/** The narrowing every parser of untyped input needs: an object, not null, not an array. A type
 *  guard, so callers read fields as `unknown` without asserting a shape they have not checked. */
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
