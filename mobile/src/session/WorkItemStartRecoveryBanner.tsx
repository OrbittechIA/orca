import { useEffect, useState } from 'react'
import { View, Text } from 'react-native'
import { readWorkItemStartRecovery } from '../tasks/work-item-start-recovery'
import { styles } from './mobile-session-styles'

export function WorkItemStartRecoveryBanner({ worktreeId }: { worktreeId: string }) {
  const [notice, setNotice] = useState<{ worktreeId: string; message: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void readWorkItemStartRecovery(worktreeId).then((recovery) => {
      if (cancelled) return
      const message = recovery.kind === 'legacy' ? recovery.message
        : recovery.kind === 'create' ? 'Work Item Start has an unconfirmed create. Its session and message identities are saved. Review the existing conversation before sending anything.' : ''
      setNotice({ worktreeId, message })
    }, () => {
      if (!cancelled) setNotice({ worktreeId, message: 'Work Item Start recovery data could not be read. Review the existing conversation before sending anything.' })
    })
    return () => { cancelled = true }
  }, [worktreeId])
  return notice?.worktreeId === worktreeId && notice.message ? (
    <View style={styles.createWarningBanner}>
      <Text style={styles.createWarningText}>{notice.message}</Text>
    </View>
  ) : null
}
