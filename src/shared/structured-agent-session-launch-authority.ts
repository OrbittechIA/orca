import type { StructuredAgentSessionLaunchAuthority } from './structured-agent-session-create'

export function isStructuredAgentSessionLaunchAuthority(
  value: unknown
): value is StructuredAgentSessionLaunchAuthority {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false
  }
  if (value.kind === 'local-desktop') {
    return Object.keys(value).length === 1
  }
  return (
    value.kind === 'paired-device' && Object.keys(value).length === 2 &&
    'deviceId' in value && typeof value.deviceId === 'string' &&
    value.deviceId.trim() === value.deviceId &&
    value.deviceId.length > 0 && value.deviceId.length <= 512
  )
}

export function structuredAgentSessionLaunchAuthoritiesEqual(
  left: StructuredAgentSessionLaunchAuthority | undefined,
  right: StructuredAgentSessionLaunchAuthority | undefined
): boolean {
  return (
    left !== undefined && right !== undefined && left.kind === right.kind &&
    (left.kind === 'local-desktop' ||
      (right.kind === 'paired-device' && left.deviceId === right.deviceId))
  )
}
