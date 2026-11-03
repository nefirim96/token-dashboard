#!/usr/bin/env node
// token-dashboard: 포르쉐 911 스타일 계기판 (오리지널 디자인)
// 외부 패키지 없음. 로컬 기록만 읽고, 어디로도 전송하지 않습니다.
//
//   node gauge.mjs              터미널 계기판
//   node gauge.mjs --html       HTML 계기판 생성 후 브라우저로 열기
//   node gauge.mjs statusline   Claude Code 상태 표시줄용 (stdin JSON 입력)
//
// 옵션: --hours 5 (집계 기간), --limit 숫자 (추정용 가중 토큰 한도, 선택)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CONFIG_DIR, 'projects');
const DATA_DIR = path.join(CONFIG_DIR, 'token-dashboard');
const SNAPSHOTS = path.join(DATA_DIR, 'snapshots.jsonl');

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'show';
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const hours = Number(flag('--hours', 5));
const limit = Number(flag('--limit', 0)); // 추정용 가중 토큰 한도 (0이면 사용 안 함)

// ---------- 공통 유틸 ----------
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function latestSnapshot() {
  try {
    const lines = fs.readFileSync(SNAPSHOTS, 'utf8').trim().split('\n');
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

// ---------- 상태 표시줄 모드 ----------
async function statusline() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let d = {};
  try { d = JSON.parse(raw); } catch { /* 입력이 없으면 빈 값으로 처리 */ }

  const rl = d.rate_limits || {};
  const five = rl.five_hour?.used_percentage ?? null;
  const seven = rl.seven_day?.used_percentage ?? null;

  if (five !== null || seven !== null) {
    const prev = latestSnapshot();
    const changed = !prev || prev.five !== five || prev.seven !== seven;
    const stale = !prev || Date.now() - prev.ts > 10 * 60e3;
    if (changed || stale) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(SNAPSHOTS, JSON.stringify({
        ts: Date.now(),
        five, five_reset: rl.five_hour?.resets_at ?? null,
        seven, seven_reset: rl.seven_day?.resets_at ?? null,
      }) + '\n');
    }
  }

  // 패널(mod)이 읽을 요약 파일. 대화 기록 전체 집계는 무거우므로 10분에 한 번만 다시 계산합니다.
  try {
    const sumFile = path.join(DATA_DIR, 'summary.json');
    const old = fs.existsSync(sumFile) ? JSON.parse(fs.readFileSync(sumFile, 'utf8')) : null;
    if (!old || Date.now() - old.ts > 10 * 60e3) {
      const agg = aggregate(Date.now() - 5 * 3600e3);
      const cacheDen = agg.tot.cacheRead + agg.tot.input + agg.tot.cacheWrite;
      const toolTotal = agg.toolTotal || 0;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(sumFile, JSON.stringify({
        ts: Date.now(),
        cacheHit: cacheDen ? Math.round((agg.tot.cacheRead / cacheDen) * 100) : null,
        topSession: agg.sessions[0] && agg.tot.weighted ? Math.round((agg.sessions[0].weighted / agg.tot.weighted) * 100) : null,
        topSessionId: agg.sessions[0] ? agg.sessions[0].id.slice(-6) : null,
        topTool: agg.tools[0] && toolTotal ? Math.round((agg.tools[0].count / toolTotal) * 100) : null,
        topToolName: agg.tools[0] ? agg.tools[0].name : null,
        weighted5h: agg.tot.weighted,
      }));
    }
  } catch { /* 요약 실패는 표시줄 동작에 영향을 주지 않습니다 */ }

  const parts = [];
  if (five !== null) parts.push(`5h ${Math.round(five)}%`);
  if (seven !== null) parts.push(`7d ${Math.round(seven)}%`);
  const ctx = d.context_window?.used_percentage;
  if (ctx != null) parts.push(`ctx ${Math.round(ctx)}%`);
  process.stdout.write(parts.join(' · ') || 'token-dashboard: 한도 정보 없음 (Pro/Max 구독에서 표시)');
}

// ---------- 로컬 기록 집계 ----------
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Claude Code는 스트리밍 중 같은 응답을 content 블록마다 한 줄씩 기록합니다.
// 그래서 requestId 기준으로 usage를 한 번만 세고, tool_use는 블록 id 기준으로 셉니다.
function scan(sinceMs) {
  const requests = new Map();
  const tools = new Map();
  for (const file of walk(PROJECTS_DIR)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"type":"assistant"')) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const m = r.message;
      if (!m?.usage) continue;
      const ts = Date.parse(r.timestamp);
      if (!(ts >= sinceMs)) continue;
      const key = r.requestId || m.id || r.uuid;
      if (!requests.has(key)) {
        requests.set(key, { ts, session: r.sessionId, cwd: r.cwd || '', model: m.model || '', u: m.usage });
      }
      for (const c of m.content || []) {
        if (c.type === 'tool_use') tools.set(c.id || `${key}:${c.name}:${tools.size}`, { name: c.name, session: r.sessionId });
      }
    }
  }
  return { requests, tools };
}

function aggregate(sinceMs) {
  const { requests, tools } = scan(sinceMs);
  const tot = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, requests: requests.size };
  const sessions = new Map();
  const projects = new Map();

  for (const q of requests.values()) {
    const u = q.u;
    const inp = u.input_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const out = u.output_tokens || 0;
    const weighted = inp + cw + out; // 캐시 읽기는 제외 (가중치 가정, README에 명시)
    tot.input += inp; tot.cacheWrite += cw; tot.cacheRead += cr; tot.output += out;

    const s = sessions.get(q.session) || { id: q.session, cwd: q.cwd, weighted: 0, requests: 0, last: 0 };
    s.weighted += weighted; s.requests += 1; s.last = Math.max(s.last, q.ts);
    sessions.set(q.session, s);

    const pName = path.basename(q.cwd || '') || '(알 수 없음)';
    const p = projects.get(pName) || { name: pName, weighted: 0, requests: 0 };
    p.weighted += weighted; p.requests += 1;
    projects.set(pName, p);
  }

  const toolCount = new Map();
  for (const t of tools.values()) toolCount.set(t.name, (toolCount.get(t.name) || 0) + 1);
  const toolTotal = [...toolCount.values()].reduce((a, b) => a + b, 0);

  tot.weighted = tot.input + tot.cacheWrite + tot.output;
  return {
    tot,
    toolTotal,
    sessions: [...sessions.values()].sort((a, b) => b.weighted - a.weighted),
    projects: [...projects.values()].sort((a, b) => b.weighted - a.weighted),
    tools: [...toolCount].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };
}

// ---------- 계기판 값 계산 ----------
// 각 다이얼: { label, value(0~100 또는 null), source, note }
function buildDials(agg, snap, agg5h) {
  const now = Date.now();
  // 공식 값은 아직 초기화 전인 창에 대해서만 사용
  const fiveOk = snap && snap.five != null && (!snap.five_reset || snap.five_reset * 1000 > now);
  const sevenOk = snap && snap.seven != null && (!snap.seven_reset || snap.seven_reset * 1000 > now);
  const ageMin = snap ? Math.round((now - snap.ts) / 60e3) : null;
  const fiveEst = limit > 0 ? Math.min(100, (agg5h.tot.weighted / limit) * 100) : null;

  const cacheDen = agg.tot.cacheRead + agg.tot.input + agg.tot.cacheWrite;
  const hit = cacheDen ? (agg.tot.cacheRead / cacheDen) * 100 : null;
  const topSession = agg.sessions[0];
  const topSessionShare = topSession && agg.tot.weighted ? (topSession.weighted / agg.tot.weighted) * 100 : null;
  const topTool = agg.tools[0];
  const topToolShare = topTool && agg.toolTotal ? (topTool.count / agg.toolTotal) * 100 : null;

  return [
    fiveOk
      ? { label: '5시간 한도', value: snap.five, source: '공식', note: `${ageMin}분 전 기준` }
      : fiveEst !== null
        ? { label: '5시간 한도', value: fiveEst, source: '추정', note: '--limit 기준 (최근 5시간)' }
        : { label: '5시간 한도', value: null, source: '없음', note: 'Pro/Max 상태 표시줄 설정 필요' },
    sevenOk
      ? { label: '7일 한도', value: snap.seven, source: '공식', note: `${ageMin}분 전 기준` }
      : { label: '7일 한도', value: null, source: '없음', note: 'Pro/Max 상태 표시줄 설정 필요' },
    { label: '캐시 적중률', value: hit, source: '실측', note: '캐시 읽기 / 전체 입력', invert: true },
    { label: '최대 세션 비중', value: topSessionShare, source: '실측', note: topSession ? `…${topSession.id.slice(-6)}` : '' },
    { label: '최다 도구 비중', value: topToolShare, source: '실측', note: topTool ? topTool.name : '' },
  ];
}

const level = (p) => (p === null ? 'none' : p < 60 ? 'green' : p < 85 ? 'yellow' : 'red');
// 높을수록 좋은 다이얼(캐시 적중률)은 색을 뒤집습니다
const levelOf = (d) => level(d.value === null ? null : d.invert ? 100 - d.value : d.value);
const LEVEL_HEX = { green: '#3ddc84', yellow: '#ffd23f', red: '#ff4d4d', none: '#555' };
const NEEDLE = ['↙', '←', '↖', '↑', '↗', '→', '↘'];

// ---------- 터미널 출력 ----------
function renderTerminal(agg, dials, hint) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const COLOR = { green: '32', yellow: '33', red: '31', none: '90' };
  const lines = [];
  lines.push(c('1', '  ◉ TOKEN CLUSTER · 최근 ' + hours + '시간'));
  if (hint) lines.push(c('33', '  ! ' + hint));
  lines.push('');
  for (const d of dials) {
    const lv = levelOf(d);
    const p = d.value === null ? 0 : Math.max(0, Math.min(100, d.value));
    const n = Math.round(p / 100 * 20);
    const bar = '█'.repeat(n) + '░'.repeat(20 - n);
    const needle = d.value === null ? '·' : NEEDLE[Math.round(p / 100 * 6)];
    const pct = d.value === null ? '  --%' : `${String(Math.round(p)).padStart(3)}%`;
    lines.push(`  ${d.label.padEnd(12, ' ')} ${needle} ${c(COLOR[lv], pct)} ${c(COLOR[lv], bar)} [${d.source}] ${d.note}`);
  }
  lines.push('');
  lines.push(`  가중 토큰 ${fmt(agg.tot.weighted)}  (입력 ${fmt(agg.tot.input)} · 캐시 생성 ${fmt(agg.tot.cacheWrite)} · 출력 ${fmt(agg.tot.output)} · 캐시 읽기 ${fmt(agg.tot.cacheRead)})`);
  lines.push(`  응답 ${fmt(agg.tot.requests)}건 · 도구 호출 ${fmt(agg.toolTotal)}회`);
  lines.push('');
  lines.push(c('1', '  많이 쓴 세션 TOP 5'));
  for (const s of agg.sessions.slice(0, 5)) {
    lines.push(`  …${s.id.slice(-6)}  ${fmt(s.weighted).padStart(12)}  ${String(s.requests).padStart(5)}응답  ${path.basename(s.cwd || '') || '-'}`);
  }
  lines.push('');
  lines.push(c('1', '  많이 쓴 프로젝트 TOP 5'));
  for (const p of agg.projects.slice(0, 5)) lines.push(`  ${p.name.padEnd(24)} ${fmt(p.weighted).padStart(12)}`);
  lines.push('');
  lines.push(c('1', '  자주 쓴 도구 TOP 8'));
  for (const t of agg.tools.slice(0, 8)) lines.push(`  ${t.name.padEnd(32)} ${fmt(t.count).padStart(6)}회`);
  lines.push('');
  lines.push(`  ※ 한도 % 는 Pro/Max 상태 표시줄 설정 후 "공식"으로 표시됩니다. 가중 토큰은 캐시 읽기를 뺀 추정 기준입니다.`);
  console.log(lines.join('\n'));
}

// ---------- HTML 출력 ----------
function arcPoint(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
// 다이얼 각도: -120도(0%) ~ +120도(100%)
const angleOf = (p) => -120 + (p / 100) * 240;

function dialSvg(d) {
  const cx = 110, cy = 110, r = 88;
  const p = d.value === null ? 0 : Math.max(0, Math.min(100, d.value));
  const lv = levelOf(d);
  const color = LEVEL_HEX[lv];
  const [x0, y0] = arcPoint(cx, cy, r, -120);
  const [x1, y1] = arcPoint(cx, cy, r, -120 + 240);
  const bg = `M${x0},${y0} A${r},${r} 0 1 1 ${x1},${y1}`;
  const endDeg = angleOf(p);
  const [vx, vy] = arcPoint(cx, cy, r, endDeg);
  const span = endDeg - -120;
  const valArc = p > 0 ? `M${x0},${y0} A${r},${r} 0 ${span > 180 ? 1 : 0} 1 ${vx},${vy}` : '';
  let ticks = '';
  for (let i = 0; i <= 10; i++) {
    const deg = -120 + i * 24;
    const [a, b] = arcPoint(cx, cy, r - 2, deg);
    const [e, f] = arcPoint(cx, cy, r - (i % 5 === 0 ? 16 : 10), deg);
    ticks += `<line x1="${a}" y1="${b}" x2="${e}" y2="${f}" stroke="${i % 5 === 0 ? '#eee' : '#888'}" stroke-width="${i % 5 === 0 ? 2.5 : 1.2}"/>`;
  }
  const [nx, ny] = arcPoint(cx, cy, r - 22, endDeg);
  const valueText = d.value === null ? '--' : `${Math.round(p)}`;
  return `
  <div class="dial">
    <svg viewBox="0 0 220 220" role="img" aria-label="${esc(d.label)} ${valueText}%">
      <defs>
        <radialGradient id="face-${esc(d.label).length}-${Math.round(p)}" cx="50%" cy="40%" r="70%">
          <stop offset="0%" stop-color="#1d1d1f"/><stop offset="100%" stop-color="#050506"/>
        </radialGradient>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="104" fill="#18181b" stroke="#3a3a40" stroke-width="3"/>
      <circle cx="${cx}" cy="${cy}" r="98" fill="url(#face-${esc(d.label).length}-${Math.round(p)})"/>
      <path d="${bg}" fill="none" stroke="#2b2b30" stroke-width="10" stroke-linecap="round"/>
      ${valArc ? `<path d="${valArc}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" style="filter:drop-shadow(0 0 6px ${color})"/>` : ''}
      ${ticks}
      <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#ff8a3d" stroke-width="2.5" stroke-linecap="round" class="needle" style="transform-origin:${cx}px ${cy}px"/>
      <circle cx="${cx}" cy="${cy}" r="7" fill="#c9c9cf"/>
      <text x="${cx}" y="${cy + 46}" text-anchor="middle" class="val" fill="${color}">${valueText}${d.value === null ? '' : '%'}</text>
    </svg>
    <div class="label">${esc(d.label)}</div>
    <div class="meta"><span class="badge b-${esc(d.source)}">${esc(d.source)}</span> ${esc(d.note)}</div>
  </div>`;
}

function renderHtml(agg, dials) {
  const now = new Date().toLocaleString('ko-KR');
  const sessionRows = agg.sessions.slice(0, 10).map((s) =>
    `<tr><td>…${esc(s.id.slice(-6))}</td><td>${esc(path.basename(s.cwd || '') || '-')}</td><td class="num">${fmt(s.weighted)}</td><td class="num">${fmt(s.requests)}</td></tr>`).join('');
  const maxTool = agg.tools[0]?.count || 1;
  const toolRows = agg.tools.slice(0, 10).map((t) =>
    `<div class="bar-row"><span>${esc(t.name)}</span><div class="bar"><i style="width:${(t.count / maxTool) * 100}%"></i></div><b>${fmt(t.count)}</b></div>`).join('');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token Cluster</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: system-ui, -apple-system, "Malgun Gothic", sans-serif; background:#0b0b0d; color:#e8e8ea; }
  header { padding:22px 16px 6px; text-align:center; letter-spacing:.25em; font-size:13px; color:#9a9aa3; }
  .cluster { display:grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap:14px; max-width:1100px; margin:10px auto 24px; padding:0 16px; }
  .dial { background:#131316; border:1px solid #26262c; border-radius:18px; padding:10px 8px 14px; text-align:center; box-shadow: inset 0 0 30px #000; }
  .dial svg { width:100%; max-width:220px; }
  .val { font-size:26px; font-weight:700; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .label { margin-top:4px; font-size:14px; font-weight:600; }
  .meta { font-size:12px; color:#8c8c95; margin-top:4px; }
  .badge { display:inline-block; padding:1px 6px; border-radius:6px; font-size:11px; border:1px solid #3a3a40; }
  .b-공식 { color:#3ddc84; border-color:#2a6b4a; } .b-추정 { color:#ffd23f; border-color:#6b5c20; } .b-없음 { color:#777; }
  section { max-width:1100px; margin:0 auto 22px; padding:0 16px; }
  h2 { font-size:13px; letter-spacing:.15em; color:#9a9aa3; font-weight:600; margin:18px 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:14px; background:#131316; border-radius:12px; overflow:hidden; }
  th, td { padding:8px 10px; border-bottom:1px solid #222228; text-align:left; }
  th { color:#9a9aa3; font-weight:500; font-size:12px; }
  td.num { text-align:right; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .bar-row { display:grid; grid-template-columns: minmax(140px, 260px) 1fr 60px; gap:10px; align-items:center; margin:6px 0; font-size:13px; }
  .bar { height:8px; background:#1f1f24; border-radius:4px; overflow:hidden; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,#3ddc84,#ffd23f,#ff4d4d); }
  .bar-row span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  th.num { text-align:right; }
  .bar-row b { text-align:right; font-family: ui-monospace, Menlo, monospace; font-weight:500; }
  .note { font-size:12px; color:#7d7d86; line-height:1.6; }
  .needle { transition: transform .6s ease; }
  @media (prefers-reduced-motion: reduce) { .needle { transition:none; } }
</style></head>
<body>
<header>TOKEN CLUSTER · 최근 ${hours}시간 · ${esc(now)}</header>
<div class="cluster">${dials.map(dialSvg).join('')}</div>
<section>
  <h2>가중 토큰</h2>
  <table>
    <tr><th class="num">입력</th><th class="num">캐시 생성</th><th class="num">출력</th><th class="num">캐시 읽기</th></tr>
    <tr><td class="num">${fmt(agg.tot.input)}</td><td class="num">${fmt(agg.tot.cacheWrite)}</td><td class="num">${fmt(agg.tot.output)}</td><td class="num">${fmt(agg.tot.cacheRead)}</td></tr>
  </table>
  <h2>많이 쓴 세션</h2>
  <table><tr><th>세션</th><th>프로젝트</th><th class="num">가중 토큰</th><th class="num">응답</th></tr>${sessionRows || '<tr><td colspan="4">데이터 없음</td></tr>'}</table>
  <h2>자주 쓴 도구</h2>
  ${toolRows || '<div class="note">데이터 없음</div>'}
  <p class="note">가중 토큰 = 입력 + 캐시 생성 + 출력 (캐시 읽기 제외, 추정 기준). 한도 %는 Pro/Max 구독자의 상태 표시줄에서 받은 값만 "공식"으로 표시합니다. 모든 계산은 이 PC의 기록 파일에서만 이루어집니다.</p>
</section>
</body></html>`;
}

function openFile(file) {
  const plat = process.platform;
  const [bin, args] = plat === 'darwin' ? ['open', [file]]
    : plat === 'win32' ? ['cmd', ['/c', 'start', '', file]]
      : ['xdg-open', [file]];
  execFile(bin, args, () => { /* 열기 실패는 무시: 경로만 안내 */ });
}

// ---------- 설치 / 제거 (settings.json 자동 설정) ----------
// 공백이 없는 경로에 스크립트를 복사하고, settings.json의 statusLine을 그 경로로 맞춥니다.
// 기존 settings.json은 백업한 뒤에만 고칩니다.
function settingsPath() {
  return path.join(CONFIG_DIR, 'settings.json');
}

function readSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text); // 잘못된 JSON이면 여기서 예외 → 파일을 건드리지 않음
}

function writeSettings(obj) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function install() {
  let settings;
  try {
    settings = readSettings();
  } catch (e) {
    console.error(`settings.json을 읽을 수 없습니다 (JSON 형식 오류): ${settingsPath()}`);
    console.error('파일을 고친 뒤 다시 실행하세요. 아무것도 바꾸지 않았습니다.');
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, 'gauge.mjs');
  fs.copyFileSync(fileURLToPath(import.meta.url), target);
  const posixTarget = target.split(path.sep).join('/');
  if (/\s/.test(posixTarget)) {
    console.warn(`경고: 설치 경로에 공백이 있습니다 (${posixTarget}). 상태 표시줄이 실행되지 않을 수 있습니다.`);
  }

  const command = `node ${posixTarget} statusline`;
  const before = settings.statusLine ? JSON.stringify(settings.statusLine) : null;
  settings.statusLine = { type: 'command', command };
  writeSettings(settings);

  console.log('설치 완료.');
  console.log(`  스크립트: ${target}`);
  console.log(`  설정 파일: ${settingsPath()}`);
  if (before) console.log(`  기존 statusLine은 백업 파일에 남아 있습니다: ${before}`);
  console.log('다음 단계: Claude Code를 완전히 껐다가 다시 열고, 메시지를 한 번 보내 보세요.');
  console.log('하단에 "5h xx% · 7d xx%"가 보이면 연결된 것입니다. (Pro/Max 구독자 전용)');
}

function uninstall() {
  let settings;
  try {
    settings = readSettings();
  } catch {
    console.error('settings.json을 읽을 수 없습니다. 아무것도 바꾸지 않았습니다.');
    process.exit(1);
  }
  const cur = settings.statusLine?.command || '';
  if (!cur.includes('token-dashboard') && !cur.includes('gauge.mjs')) {
    console.log('token-dashboard의 statusLine이 없습니다. 아무것도 바꾸지 않았습니다.');
    return;
  }
  delete settings.statusLine;
  writeSettings(settings);
  console.log('statusLine을 제거했습니다. 백업 파일은 그대로 남아 있습니다.');
}

// ---------- 진입점 ----------
if (cmd === 'install') {
  install();
} else if (cmd === 'uninstall') {
  uninstall();
} else if (cmd === 'statusline') {
  await statusline();
} else {
  const sinceMs = Date.now() - hours * 3600e3;
  const agg = aggregate(sinceMs);
  const agg5h = hours === 5 ? agg : aggregate(Date.now() - 5 * 3600e3);
  const dials = buildDials(agg, latestSnapshot(), agg5h);
  const hint = agg.tot.requests === 0
    ? `최근 ${hours}시간 안에 기록이 없습니다. --hours 720 (30일) 처럼 기간을 늘려 보세요.`
    : '';
  if (cmd === 'html' || argv.includes('--html')) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = path.join(DATA_DIR, 'dashboard.html');
    fs.writeFileSync(out, renderHtml(agg, dials));
    console.log(`계기판 저장: ${out}`);
    openFile(out);
  } else {
    renderTerminal(agg, dials, hint);
  }
}
