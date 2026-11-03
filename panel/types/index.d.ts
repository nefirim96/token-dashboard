// 이 mod가 $.state에 저장하는 값의 계약.
export type Usage = {
  fiveHour: number | null
  sevenDay: number | null
  updatedAt: number | null
  ctx: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-dashboard-panel': { usage: Usage }
  }
}
