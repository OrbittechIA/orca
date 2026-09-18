import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../../../shared/canonical-json'

export function humanGateFingerprint(domain: 'request' | 'receipt', value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ domain: `orca.human-gate.${domain}.v1`, value }))
    .digest('hex')
}
