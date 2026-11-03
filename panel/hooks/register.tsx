import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Usage } from '../types'

const PANE = 'token-dashboard'
// 값의 모양이 바뀌면 shape 태그를 올려서 이전 버전이 저장한 값을 거절하게 합니다.
const usage = atom({ plugin: 'token-dashboard-panel', key: 'usage' } as const, null as Usage | null, {
  shape: 'usage-3',
})

const EMPTY: Usage = {
  fiveHour: null,
  sevenDay: null,
  updatedAt: null,
  cacheHit: null,
  topSession: null,
  topSessionId: null,
  topTool: null,
  topToolName: null,
}

// token-dashboard 상태 표시줄 스크립트가 남긴 두 파일을 읽습니다.
// snapshots.jsonl: 공식 한도 %, summary.json: 캐시·세션·도구 비중 (10분마다 갱신)
async function loadUsage($: any): Promise<Usage> {
  let home = ''
  try {
    home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  } catch {
    return EMPTY
  }
  if (!home) return EMPTY
  const base = `${home}/.claude/token-dashboard`
  const out: Usage = { ...EMPTY }
  const now = Date.now()

  try {
    const text: string = await $.fs.read(`${base}/snapshots.jsonl`)
    const last = text.trim().split('\n').filter(Boolean).at(-1)
    if (last) {
      const s = JSON.parse(last)
      const fiveOk = s.five != null && (!s.five_reset || s.five_reset * 1000 > now)
      const sevenOk = s.seven != null && (!s.seven_reset || s.seven_reset * 1000 > now)
      out.fiveHour = fiveOk ? s.five : null
      out.sevenDay = sevenOk ? s.seven : null
      out.updatedAt = typeof s.ts === 'number' ? s.ts : null
    }
  } catch {
    // 기록이 없으면 값은 비워 둡니다
  }

  try {
    const s = JSON.parse(await $.fs.read(`${base}/summary.json`))
    out.cacheHit = s.cacheHit ?? null
    out.topSession = s.topSession ?? null
    out.topSessionId = s.topSessionId ?? null
    out.topTool = s.topTool ?? null
    out.topToolName = s.topToolName ?? null
  } catch {
    // 요약이 아직 없으면 세 항목은 비워 둡니다
  }

  return out
}

function bar(pct: number | null, width = 20): string {
  if (pct === null) return '·'.repeat(width)
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

function label(pct: number | null): string {
  return pct === null ? '--' : `${Math.round(pct)}%`
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

  // 응답 시작·끝에 기록을 다시 읽어 저장합니다. 저장된 값은 패널이 그릴 때 사용합니다.
  on('turn.start', async ($, e, next) => {
    // update의 함수는 값을 바로 돌려줘야 합니다. Promise를 넘기면 NaN이 됩니다.
    const snap = await loadUsage($)
    await update($, usage, () => snap)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const snap = await loadUsage($)
    await update($, usage, () => snap)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    try {
      return await drawPane($, Box, Text)
    } catch (err) {
      return (
        <Box flexDirection="column">
          <Text>계기판을 그리지 못했습니다.</Text>
          <Text dimColor>{String((err as Error)?.message ?? err)}</Text>
        </Box>
      )
    }
  })
}

async function drawPane($: any, Box: any, Text: any) {
    let u = await read($, usage)
    if (!u) {
      u = await loadUsage($)
      await update($, usage, () => u)
    }

    const rows: Array<{ name: string; value: number | null; note?: string }> = [
      { name: '5시간 한도', value: u.fiveHour },
      { name: '7일 한도', value: u.sevenDay },
      { name: '캐시 적중률', value: u.cacheHit },
      { name: '최대 세션 비중', value: u.topSession, note: u.topSessionId ? `…${u.topSessionId}` : undefined },
      { name: '최다 도구 비중', value: u.topTool, note: u.topToolName ?? undefined },
    ]

    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Box flexDirection="column">
            <Text bold>
              {row.name}  {label(row.value)}
              {row.note ? `  ${row.note}` : ''}
            </Text>
            <Text>{bar(row.value)}</Text>
          </Box>
        ))}
        <Text dimColor>
          {u.updatedAt === null
            ? '상태 표시줄 설치 후 응답을 한 번 받으면 값이 나옵니다.'
            : `공식 값 · ${minutesAgo(u.updatedAt)} 기준`}
        </Text>
      </Box>
    )
}
