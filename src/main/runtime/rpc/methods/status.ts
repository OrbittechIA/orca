import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { readBuildProvenance } from '../../../../shared/build-provenance'
import { getRuntimeBuildAttestation } from '../../runtime-executable-attestation'

const buildProvenance = readBuildProvenance()

export const STATUS_METHODS = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, pairedDeviceId }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        // Opcional e aditivo: um cliente antigo ignora, e um novo consegue amarrar este
        // servidor ao commit que o produziu — `appVersion` sozinho não distingue builds.
        ...(buildProvenance ? { buildProvenance } : {}),
        remoteUpdateSupport: snapshot.support
      }
    }
  }),
  defineMethod({
    name: 'runtime.buildAttestation',
    params: null,
    // Estreito e sob demanda: hashear o executável é caro, então quem precisa da prova paga
    // por ela — uma vez, memorizada — em vez de todo processo pagar no boot.
    handler: () => getRuntimeBuildAttestation()
  })
]
