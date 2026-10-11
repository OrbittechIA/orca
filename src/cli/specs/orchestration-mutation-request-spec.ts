import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_MUTATION_REQUEST_SHOW_SPEC: CommandSpec = {
  path: ['orchestration', 'request-show'],
  summary: 'Ask whether one orchestration mutation request already took effect',
  usage:
    'orca orchestration request-show (--request <request_id> | --method terminal.send --payload-hash <base:binding>) [--current-terminal <handle>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'request',
    'method',
    'payload-hash',
    'terminal',
    'process-incarnation',
    'generation',
    'provider',
    'current-terminal',
    'provider-session'
  ],
  notes: [
    'Read-only: it never starts, retries, or settles anything, so it is safe to run after any lost response.',
    'Lookup requires the full canonical Orca base:binding hash; a Core pending fingerprint is not that hash. Optional --terminal, --process-incarnation, --generation and --provider filter recorded prompt fields. Zero/multiple matches remain ambiguous.',
    '--current-terminal observes a unique live pane/connection/launch/provider-session binding for a matched receipt; --provider-session checks an expected session ID. Observed is not recovery authorization or historical session continuity. Old hosts must report unsupported evidence.',
    'completed means the mutation landed and --retry-request replays the recorded outcome instead of starting a second one. pending means the original mutation is still running or Orca restarted before recording its outcome; wait for a live original command, otherwise replay with --retry-request.',
    'absent means this runtime holds no receipt for that request under your caller identity: it never arrived, it failed before recording anything, or the receipt was pruned. Absent is not proof that nothing happened.'
  ]
}
