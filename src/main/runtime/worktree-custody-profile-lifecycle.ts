import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'

type CustodyShutdownAuthority = { closeAdmissions(): void; sealClosedEpoch(): boolean }
const authorities = new Map<string, CustodyShutdownAuthority>()

export function registerCustodyShutdownAuthority(
  userDataPath: string,
  authority: CustodyShutdownAuthority
): void {
  authorities.set(userDataPath, authority)
}

export function closeNativeWorktreeCustodyAdmissions(): void {
  if (hasAppEnvironment()) {
    authorities.get(getAppEnvironment().getPath('userData'))?.closeAdmissions()
  }
}

/** A closed-admission seal alone cannot certify missing epoch succession. */
export function sealNativeWorktreeCustodyEpochs(): void {
  if (!hasAppEnvironment()) {
    return
  }
  const authority = authorities.get(getAppEnvironment().getPath('userData'))
  if (authority && !authority.sealClosedEpoch()) {
    console.warn('[worktree-custody] clean epoch seal unavailable')
  }
}
