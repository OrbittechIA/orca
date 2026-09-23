import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { RotateCcw } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import { readWorkItemStartAttempt } from '../tasks/work-item-start-attempt-journal'
import { retryWorkItemStartStructuredSession } from '../tasks/work-item-start-structured-session'

/**
 * Offers Retry Start for a strict Work Item Start whose workspace exists but whose session was
 * never confirmed. The retry re-enters the recorded session and operations for this workspace;
 * it never creates another workspace.
 */
export function WorkItemStartRetryBanner({
  client,
  worktreeId
}: {
  client: RpcClient | null
  worktreeId: string
}) {
  const [pending, setPending] = useState(false)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // A second tap lands before `running` re-renders; the ref closes that window.
  const runningRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void readWorkItemStartAttempt(worktreeId).then(
      (attempt) => {
        if (!cancelled) {
          setPending(attempt !== null)
        }
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [worktreeId])

  const retry = useCallback(async () => {
    if (!client || runningRef.current) {
      return
    }
    runningRef.current = true
    setRunning(true)
    try {
      // Re-reads the journal inside the per-workspace flight; `null` means a Start already settled.
      const outcome = await retryWorkItemStartStructuredSession({ client, worktreeId })
      setPending(outcome?.kind === 'unconfirmed')
      setMessage(outcome && outcome.kind !== 'started' ? outcome.message : null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Retry Start failed.')
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [client, worktreeId])

  if (!pending && !message) {
    return null
  }
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>{message ?? 'The Work Item Start session was not confirmed.'}</Text>
      {pending ? (
        <Pressable
          style={styles.button}
          onPress={() => void retry()}
          disabled={!client || running}
          accessibilityRole="button"
          accessibilityLabel="Retry Work Item Start"
        >
          {running ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <RotateCcw size={14} color={colors.textPrimary} strokeWidth={2.2} />
          )}
          <Text style={styles.buttonText}>Retry Start</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  text: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  buttonText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize
  }
})
