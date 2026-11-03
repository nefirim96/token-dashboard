import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Usage } from '../types'

const PANE = 'token-dashboard'
// 값이 바뀌면 shape 태그를 올려서 이전 버전이 저장한 값을 거절하게 합니다.
const usage = atom({ plugin: 'token-dashboard-panel', key: 'usage' } as const, null as Usage | null, {
  shape: 'usage-2',
})

const EMPTY: Usage = { fiveHour: null, sevenDay: null, updatedAt: null, ctx: null }

// 같은 프로그램(statusline)이 남긴 기록 파일의 마지막 줄을 읽습니다.
async function loadSnapshot($: any): Promise<Usage> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  if (!home) return EMPTY
  try {
    const text: string = await $.fs.read(`${home}/.claude/token-dashboard/snapshots.jsonl`)
    const last = text.trim().split('\n').filter(Boolean).at(-1)
    if (!last) return EMPTY
    const s = JSON.parse(last)
    const now = Date.now()
    const fiveOk = s.five != null && (!s.five_reset || s.five_reset * 1000 > now)
    const sevenOk = s.seven != null && (!s.seven_reset || s.seven_reset * 1000 > now)
    return {
      fiveHour: fiveOk ? s.five : null,
      sevenDay: sevenOk ? s.seven : null,
      updatedAt: s.ts ?? null,
      ctx: null,
    }
  } catch {
    return EMPTY
  }
}

function bar(pct: number | null, width = 20): string {
  if (pct === null) return '·'.repeat(width)
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

function tone(pct: number | null): 'green' | 'yellow' | 'red' | 'dim' {
  if (pct === null) return 'dim'
  return pct < 60 ? 'green' : pct < 85 ? 'yellow' : 'red'
}

function minutesAgo(ts: number | null): string {
  if (ts === null) return ''
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  return m === 0 ? '방금' : `${m}분 전`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-gauge',
      description: '토큰 사용률 계기판 패널을 엽니다',
    })
    void $.ui.open({ id: PANE, title: '사용률' })
    return next(e)
  })

  on('command.run', { command: 'token-gauge' }, async $ => {
    await $.ui.open({ id: PANE, title: '사용률' })
    return { text: '사용률 패널을 열었습니다.' }
  })

  // 응답 중에도 기록 파일을 다시 읽습니다 (상태 표시줄 값이 응답 중에 갱신되므로).
  on('turn.start', async ($, e, next) => {
    // update의 함수는 값을 바로 돌려줘야 합니다. Promise를 넘기면 NaN이 됩니다.
    const snap = await loadSnapshot($)
    await update($, usage, () => snap)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const snap = await loadSnapshot($)
    await update($, usage, () => snap)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    let u = await read($, usage)
    if (!u) {
      u = await loadSnapshot($)
      await update($, usage, () => u)
    }

    return (
      <Box flexDirection="column">
        <Text bold>5시간 한도  {u.fiveHour === null ? '--' : `${Math.round(u.fiveHour)}%`}</Text>
        <Text>{bar(u.fiveHour)}</Text>
        <Text bold>7일 한도  {u.sevenDay === null ? '--' : `${Math.round(u.sevenDay)}%`}</Text>
        <Text>{bar(u.sevenDay)}</Text>
        <Text dimColor>
          {u.updatedAt === null
            ? 'Pro/Max 구독자는 상태 표시줄을 연결하면 값이 나옵니다.'
            : `공식 값 · ${minutesAgo(u.updatedAt)} 기준`}
        </Text>
      </Box>
    )
  })
}
