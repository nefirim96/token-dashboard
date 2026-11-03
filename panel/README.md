# token-dashboard-panel

Claude Code 채팅 옆 패널에 토큰 사용률 계기판을 띄웁니다. 5시간·7일 한도 사용률을 보여 주며, 값은 `token-dashboard` 상태 표시줄 스크립트가 남긴 기록(`~/.claude/token-dashboard/snapshots.jsonl`)에서 읽습니다.

Pro/Max 구독자만 값이 나옵니다. 먼저 `token-dashboard`의 설치 명령(`npx github:nefirim96/token-dashboard install`)으로 상태 표시줄을 연결해 주세요. 패널은 `/token-gauge` 명령으로 열 수 있습니다.
