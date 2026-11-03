# token-dashboard

Claude Code 사용량을 포르쉐 911 계기판 스타일로 보여 주는 도구입니다. (오리지널 디자인이며 포르쉐 로고나 상표를 쓰지 않습니다.)

- 터미널 계기판과 HTML 계기판을 둘 다 제공합니다.
- 세션·프로젝트·도구별로 많이 쓴 것을 순위로 보여 줍니다.
- Pro/Max 구독자는 상태 표시줄을 연결하면 5시간·7일 한도 사용률을 공식 값으로 볼 수 있습니다.

외부 패키지가 필요 없습니다. Node.js만 있으면 됩니다. 모든 계산은 이 PC의 기록 파일에서만 이루어지며, 어디에도 전송하지 않습니다.

## 준비

- Node.js 18 이상 (확인: `node -v`)
- 파일: `gauge.mjs`

## 사용법

```bash
node gauge.mjs                 # 터미널 계기판 (최근 5시간)
node gauge.mjs --hours 720     # 최근 30일로 보기
node gauge.mjs --html          # HTML 계기판을 만들고 브라우저로 열기
node gauge.mjs --limit 5000000 # 5시간 한도 추정용 가중 토큰 한도 (선택)
```

Windows PowerShell에서는 경로에 공백이나 한글이 있으면 큰따옴표로 감싸세요.

```powershell
node "D:\클로드 개발\token-dashboard\gauge.mjs" --hours 720
```

Claude Code 세션 안에서는 입력창에 `!`를 붙여 실행할 수 있습니다. 예: `! node /경로/gauge.mjs`

## Claude Code에 맡기기

Claude Code를 쓰고 있다면, 아래 문장을 그대로 붙여넣으면 설치를 맡길 수 있습니다.

```
https://github.com/nefirim96/token-dashboard 의 README를 읽고 token-dashboard를 설치해 줘.
설치 명령은 "npx github:nefirim96/token-dashboard install" 이야.
설치 후 ~/.claude/settings.json의 statusLine이 들어갔는지 확인하고, "--html" 계기판을 열어 줘.
```

설치 명령은 설정 파일을 고치므로, Claude Code가 실행 허락을 물으면 허용해 주세요.

## 빠른 설치 (권장)

Node.js 18 이상이 있으면 아래 명령 한 줄로 설치할 수 있습니다. `settings.json`은 자동으로 고치고, 고치기 전에 백업을 만듭니다.

```bash
npx github:nefirim96/token-dashboard install
```

- 설치 후 Claude Code를 완전히 껐다가 다시 열고, 메시지를 한 번 보내세요. 하단에 `5h xx% · 7d xx%`가 보이면 연결된 것입니다. (Pro/Max 구독자 전용)
- 계기판 보기: `npx github:nefirim96/token-dashboard --html`
- 되돌리기: `npx github:nefirim96/token-dashboard uninstall`

아래의 수동 설정은 자동 설치가 안 될 때 쓰세요.

## 한도 % 연결 (Pro/Max 구독자)

Claude Code는 상태 표시줄 스크립트에 5시간·7일 한도 사용률을 넘겨 줍니다. `~/.claude/settings.json`에 아래를 넣으세요. 기존 `statusLine` 설정이 있으면 백업 후 바꾸세요.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /절대경로/gauge.mjs statusline"
  }
}
```

**Windows 주의:** 경로에 공백이나 한글(`클로드 개발`)이 있으면 Claude Code 상태 표시줄에서 실행이 실패했습니다. 그래서 파일을 공백·한글이 없는 경로로 복사해서 쓰세요.

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\token-dashboard" | Out-Null
Copy-Item "D:\클로드 개발\token-dashboard\gauge.mjs" "$HOME\.claude\token-dashboard\gauge.mjs"
```

그다음 `settings.json`에 아래처럼 넣습니다. (실제 설치에서 동작을 확인한 형태입니다.)

```json
"command": "node C:/Users/사용자이름/.claude/token-dashboard/gauge.mjs statusline"
```

설정 후 Claude Code에서 메시지를 한 번 보내면 하단에 `5h 24% · 7d 41%`가 나타나고, 값이 `snapshots.jsonl`에 쌓입니다. 이 기록은 `~/.claude/token-dashboard/`에 저장되며, 계기판이 최신 값을 "공식"으로 표시합니다.

## 값의 출처와 한계

| 다이얼 | 출처 | 설명 |
|---|---|---|
| 5시간 / 7일 한도 | 공식 (상태 표시줄) | Pro/Max 구독자만. 설정 후 세션이 한 번 응답해야 나옵니다. |
| 5시간 한도 | 추정 (`--limit` 지정 시) | 공식 값이 없을 때만 쓰는 추정치입니다. |
| 캐시 적중률 | 실측 | 캐시 읽기 / 전체 입력 |
| 최대 세션 비중, 최다 도구 비중 | 실측 | 기간 내 순위 기준 |

- 가중 토큰 = 입력 + 캐시 생성 + 출력입니다. 캐시 읽기는 뺍니다. 이 가중치는 가정이며, 실제 한도 계산 방식과 다를 수 있습니다.
- API 키로 쓰는 경우 한도 %는 나오지 않습니다. 사용량 표와 순위만 보입니다.
- 상태 표시줄 값은 설정 이후의 것만 기록됩니다. 과거 한도 기록은 복원할 수 없습니다.
- 기록 파일은 Claude Code 버전에 따라 형식이 바뀔 수 있습니다.

## 파일 구성

- `gauge.mjs`: 계기판 본체 (터미널, HTML, 상태 표시줄)
- `docs/`: 화면 스크린샷
- `CLAUDE.md`, `PROMPT.md`: 작업 규칙과 초기 요구사항
