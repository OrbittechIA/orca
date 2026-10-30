import { expect, it } from 'vitest'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'

it('validates persisted launch ownership and retains unowned legacy origins for explicit recovery', () => {
  const record = agentSessionRecordFixture()
  for (const launchAuthority of [
    { kind: 'local-desktop' },
    { kind: 'paired-device', deviceId: 'paired-1' }
  ]) {
    expect(isPersistedAgentSessionRecord({
      ...record, launchOrigin: 'work-item-start', launchAuthority
    })).toBe(true)
    expect(isPersistedAgentSessionRecord({ ...record, launchAuthority })).toBe(false)
  }
  expect(isPersistedAgentSessionRecord({ ...record, launchOrigin: 'work-item-start' })).toBe(true)
  for (const launchAuthority of [
    { kind: 'paired-device', deviceId: '' },
    { kind: 'local-desktop', deviceId: 'forged' },
    { kind: 'paired-device', deviceId: 'paired-1', callerKey: 'forged' }
  ]) {
    expect(isPersistedAgentSessionRecord({
      ...record, launchOrigin: 'work-item-start', launchAuthority
    })).toBe(false)
  }
})
