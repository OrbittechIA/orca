import { useEffect, useState } from 'react'
import { View, Text } from 'react-native'
import { readWorkItemStartRecovery } from '../tasks/work-item-start-recovery'
import { styles } from './mobile-session-styles'

export function WorkItemStartRecoveryBanner({ worktreeId, hostId }: { worktreeId: string; hostId: string }) {
  const [notice, setNotice] = useState<{ hostId: string; worktreeId: string; message: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void readWorkItemStartRecovery(worktreeId, hostId).then((recovery) => {
      if (cancelled) return
      const message = recovery.kind === 'legacy' ? recovery.message
        : recovery.kind === 'create' ? 'Work Item Start has an unconfirmed create. Its session and message identities are saved. Review the existing conversation before sending anything.' : ''
      setNotice({ hostId, worktreeId, message })
    }, () => {
      if (!cancelled) setNotice({ hostId, worktreeId, message: 'Work Item Start recovery data could not be read. Review the existing conversation before sending anything.' })
    })
    return () => { cancelled = true }
  }, [worktreeId, hostId])
  return notice?.hostId === hostId && notice.worktreeId === worktreeId && notice.message ? (
    <View style={styles.createWarningBanner}>
      <Text style={styles.createWarningText}>{notice.message}</Text>
    </View>
  ) : null
}
