import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalNumberFlag, getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type {
  OrchestrationMutationRequestResult,
  OrchestrationMutationRequestShowResult
} from '../../../shared/orchestration-mutation-request'
import { RequestShowParams } from '../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'

export const ORCHESTRATION_REQUEST_SHOW_HANDLER: Record<string, CommandHandler> = {
  'orchestration request-show': async ({ flags, client, json }) => {
    const prompt = {
      terminal: getOptionalStringFlag(flags, 'terminal'),
      processIncarnation: getOptionalStringFlag(flags, 'process-incarnation'),
      generation: getOptionalNumberFlag(flags, 'generation'),
      provider: getOptionalStringFlag(flags, 'provider')
    }
    const parsed = RequestShowParams.safeParse({
      request: getOptionalStringFlag(flags, 'request'),
      method: getOptionalStringFlag(flags, 'method'),
      payloadHash: getOptionalStringFlag(flags, 'payload-hash'),
      ...(Object.values(prompt).some((value) => value !== undefined) ? { prompt } : {}),
      currentTerminal: getOptionalStringFlag(flags, 'current-terminal'),
      providerSessionId: getOptionalStringFlag(flags, 'provider-session')
    })
    if (!parsed.success) {
      throw new RuntimeClientError(
        'invalid_argument',
        parsed.error.issues.map((issue) => issue.message).join(' ')
      )
    }
    const params = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined)
    )
    const response = await client
      .call<OrchestrationMutationRequestResult>('orchestration.requestShow', params)
      .catch((error: unknown) => {
        // Why: an Orca server older than request-show answers method_not_found, which reads
        // as a bug rather than a version gap on the very path a lost response sends you down.
        if (
          error instanceof RuntimeClientError &&
          (error.code === 'method_not_found' ||
            (!parsed.data.request && error.code === 'invalid_argument'))
        ) {
          throw new RuntimeClientError(
            'incompatible_runtime',
            'This Orca server cannot look up orchestration mutation requests yet. Update Orca on the server, or inspect the Dispatch directly with orchestration worker-show.'
          )
        }
        throw error
      })
    const result = response.result
    const bindingResult = 'lookup' in result ? result.match : result
    if (
      (!parsed.data.request &&
        (!('lookup' in result) ||
          result.lookup.version !== 1 ||
          (result.lookup.outcome === 'matched' && !result.match))) ||
      (parsed.data.currentTerminal && bindingResult && bindingResult.currentBinding === undefined)
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This server does not provide the requested receipt lookup/current binding evidence. No recovery was performed.'
      )
    }
    printResult(response, json, (value) =>
      'lookup' in value
        ? `[${value.lookup.outcome}]\n${value.interpretation}${value.match ? `\n${renderRequest(value.match)}` : ''}`
        : renderRequest(value)
    )
  }
}

function renderRequest(value: OrchestrationMutationRequestShowResult): string {
  const request = `${value.requestId} [${value.state}]${value.method ? ` ${value.method}` : ''}`
  const binding = value.currentBinding
    ? `\nCurrent binding: ${value.currentBinding.state} — ${value.currentBinding.reason}`
    : ''
  return `${request}\n${value.interpretation}${binding}`
}
