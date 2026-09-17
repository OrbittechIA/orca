export type WorktreeScanFailure = {
  kind: 'xcode-license' | 'developer-tools' | 'architecture-mismatch' | 'unknown'
  message: string
  fixCommand?: string
}

export function classifyWorktreeScanFailure(reason: string): WorktreeScanFailure {
  if (/Agreeing to the Xcode\/iOS license requires admin privileges/i.test(reason)) {
    return {
      kind: 'xcode-license',
      message: 'Apple developer tools require license acceptance before Git can run.',
      fixCommand: 'sudo xcodebuild -license'
    }
  }
  if (/no developer tools were found/i.test(reason)) {
    return {
      kind: 'developer-tools',
      message: 'Apple command-line developer tools are missing or unavailable.',
      fixCommand: 'xcode-select --install'
    }
  }
  if (/Unknown system error -86|EBADARCH|Bad CPU type in executable/i.test(reason)) {
    return {
      kind: 'architecture-mismatch',
      message:
        'Git could not start because an executable has an incompatible CPU architecture for this execution host. Install a Git build that matches the host architecture.'
    }
  }
  return { kind: 'unknown', message: reason }
}
