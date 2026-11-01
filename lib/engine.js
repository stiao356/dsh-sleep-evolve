// dsh-sleep-evolve · 引擎层（纯逻辑，不依赖 Cordis，可单测）
//
// 职责：在"睡眠窗口"里把一天的经历整理成可进化的记忆：
//   输入（只读）：
//     · QQ 私聊      —— surfcore state/social-v2.json 的 private:* 会话 recentMessages
//     · 记忆卡       —— surfcore 角色目录 memory/memory-card.json（衰减卡，只读摘要）
//     · DSH 全量会话 —— dsh-hippocampus 的 stream.jsonl（含所有 QQ/B站 DSH 会话）
//     · B站学习      —— watch-history.jsonl / scores.json / bili-memory.md / 私人日记
//     · B站私信      —— dm-await --once --any --json（子进程拉取，只读）
//   输出（只写自己的目录 ~/.dsh/sleep-evolve/，绝不写 surfcore/海马体文件）：
//     · journal.jsonl 进化笔记（只追加）
//     · human-world.md 每日一句人格基质（带来源+修订号，可删段撤回）
//     · proposals.json 待确认提案（记忆卡操作 / 生活参数建议，AI 只提议、人确认）
//     · status.json   上次运行结果（失败可见：ok/code/error/hint）
//     · journal.md    最近 7 天汇总（给鱼快速读）
//
// 预算硬闸：maxInputChars / maxRequests / maxTokens / timeoutMs，超限即停、不重试。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = {
  window: { start: '00:10', end: '05:30' }, // 睡眠整理窗口（本地时间，一天最多跑一次）
  lookbackHours: 30,                        // 数据回看窗口（小时）
  // 2026-11-01 主人要求：每个私聊取 120 条，主人自己的取 240 条
  perConv: 120,                             // 每个 QQ 私聊取最近多少条消息
  ownerPerConv: 240,                        // 主人自己那个私聊取多少条
  groupPerConv: 150,                        // 每个 QQ 群取最近多少条消息
  groupTotalChars: 20000,                   // QQ 群聊段落的总字符上限
  minQuietMinutes: 60,                      // 最近 N 分钟内 QQ 有活动则跳过（避免整理和聊天抢额度）
  maxInputChars: 60000,                     // 拼给模型的总输入上限（字符）
  maxRequests: 2,                           // 单次整理的模型请求数上限
  maxTokens: 8000,                          // 单次整理输出 token 上限
  timeoutMs: 240000,                        // 单次模型调用超时
  journalLimit: 5,                          // 每夜进化笔记条数上限
  substrateLimit: 1,                        // 每天一句（人格基质）
  proposalLimit: 5,                         // 每夜记忆卡提案上限
  paramSuggestionLimit: 3,                  // 每夜生活参数建议上限
  dmPollTimeoutMs: 25000,                   // B站私信拉取超时
  report: { enabled: true, maxChars: 280 }, // B站私信汇报（只发主人）
  surfcoreRepo: 'F:/feiyu/surfcore',        // surfcore 仓库根（优先自动探测）
  nodeCmd: '',                              // 调 bili.mjs 用的 node（留空自动探测）
  enableTools: true,                        // 注册 sleep_evolve_* 工具
};

const QQ_NUMBER_RE = /\d{5,12}/g;

export function resolveDshHome(env = process.env) {
  return (env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
}

export function resolveSurfcoreRepo(dshHome, configured, env = process.env) {
  const candidates = [];
  if (configured && typeof configured === 'string' && configured.trim()) candidates.push(configured.trim());
  if (env.SURFCORE_REPO) candidates.push(env.SURFCORE_REPO);
  // 插件安装目录的 realpath（link 安装时指向仓库）
  const profileRoot = path.resolve(dshHome, 'profiles');
  if (fs.existsSync(profileRoot)) {
    for (const p of fs.readdirSync(profileRoot)) {
      const link = path.join(profileRoot, p, 'node_modules', 'surfcore');
      if (fs.existsSync(link)) {
        try { candidates.push(fs.realpathSync(link)); } catch { /* ignore */ }
      }
    }
  }
  candidates.push('F:/feiyu/surfcore');
  for (const c of candidates) {
    const repo = c.replace(/[\\/]+$/, '');
    if (repo && fs.existsSync(path.join(repo, 'state')) && fs.existsSync(path.join(repo, 'plugins', 'surfcore', 'tools', 'bili.mjs'))) {
      return repo;
    }
  }
  return null;
}

export function resolveNodeCmd(configured, env = process.env) {
  const candidates = [];
  if (configured && typeof configured === 'string' && configured.trim()) candidates.push(configured.trim());
  if (env.DSH_NODE) candidates.push(env.DSH_NODE);
  candidates.push('node');
  const runtimes = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  if (fs.existsSync(runtimes)) {
    for (const rt of fs.readdirSync(runtimes)) {
      candidates.push(path.join(runtimes, rt, 'dependencies', 'node', 'bin', 'node.exe'));
    }
  }
  for (const c of candidates) {
    if (c === 'node' && (process.platform !== 'win32')) return c;
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

function safeJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readTailLines(file, maxLines) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function readTailChars(file, maxChars) {
  try {
    if (!fs.existsSync(file)) return '';
    const raw = fs.readFileSync(file, 'utf8');
    return raw.length > maxChars ? '…(截断)\n' + raw.slice(-maxChars) : raw;
  } catch {
    return '';
  }
}

export function maskNumbers(text) {
  return String(text ?? '').replace(QQ_NUMBER_RE, (m) => `${m.slice(0, 3)}****`);
}

function nowIso() { return new Date().toISOString(); }
function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 睡眠窗口判定 ──────────────────────────────────────────────
export function inWindow(now = new Date(), start = '00:10', end = '05:30') {
  const p = (n) => String(n).padStart(2, '0');
  const cur = `${p(now.getHours())}:${p(now.getMinutes())}`;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end; // 跨午夜窗口
}

export function qqActiveRecently(socialV2File, quietMinutes, nowMs = Date.now()) {
  const st = safeJson(socialV2File, {});
  const conv = st.conversations || {};
  const cutoff = nowMs - quietMinutes * 60000;
  for (const key of Object.keys(conv)) {
    if (!key.startsWith('private:')) continue;
    const c = conv[key] || {};
    if ((c.lastIncomingAt || 0) > cutoff || (c.lastAiReplyAt || 0) > cutoff) return true;
  }
  return false;
}

// ── 采集：QQ 私聊（social-v2.json 的 private:* 会话） ──────────
export function collectQqPrivates(socialV2File, opts = {}) {
  const {
    lookbackHours = 30, perConv = 120, perConvChars = 12000, totalChars = 48000,
    ownerPerConv = 240, ownerKey = '',
  } = opts;
  const st = safeJson(socialV2File, {});
  const conv = st.conversations || {};
  const cutoff = Date.now() - lookbackHours * 3600000;
  const sections = [];
  let used = 0;
  for (const key of Object.keys(conv)) {
    if (!key.startsWith('private:')) continue;
    const c = conv[key] || {};
    // 主人的会话多取一倍（2026-11-01 主人要求）
    const take = ownerKey && key === ownerKey ? ownerPerConv : perConv;
    const msgs = (c.recentMessages || []).slice(-take);
    const lines = [];
    for (const m of msgs) {
      const t = m.time || 0;
      if (t && t < cutoff) continue;
      const who = m.isSelf ? '我' : (m.sender || key.replace('private:', ''));
      const text = maskNumbers(String(m.plain || m.text || '[非文本]')).replace(/\s+/g, ' ').slice(0, 200);
      const when = t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '';
      lines.push(`[${when}] ${who}: ${text}`);
    }
    if (!lines.length) continue;
    let block = lines.join('\n');
    if (block.length > perConvChars) block = block.slice(-perConvChars);
    if (used + block.length > totalChars) break;
    sections.push(`## QQ私聊 ${maskNumbers(key.replace('private:', ''))}\n${block}`);
    used += block.length + key.length + 16;
  }
  return sections.length ? sections.join('\n\n') : '';
}

// ── 采集：QQ 群聊（social-v2.json 的 group:* 会话） ────────────
export function collectQqGroups(socialV2File, opts = {}) {
  const {
    lookbackHours = 30, perGroup = 150, perGroupChars = 10000, totalChars = 20000,
  } = opts;
  const st = safeJson(socialV2File, {});
  const conv = st.conversations || {};
  const cutoff = Date.now() - lookbackHours * 3600000;
  const sections = [];
  let used = 0;
  for (const key of Object.keys(conv)) {
    if (!key.startsWith('group:')) continue;
    const c = conv[key] || {};
    const msgs = (c.recentMessages || []).slice(-perGroup);
    const lines = [];
    for (const m of msgs) {
      const t = m.time || 0;
      if (t && t < cutoff) continue;
      const who = m.isSelf ? '我' : (m.sender || '群友');
      const text = maskNumbers(String(m.plain || m.text || '[非文本]')).replace(/\s+/g, ' ').slice(0, 200);
      const when = t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '';
      lines.push(`[${when}] ${who}: ${text}`);
    }
    if (!lines.length) continue;
    let block = lines.join('\n');
    if (block.length > perGroupChars) block = block.slice(-perGroupChars);
    if (used + block.length > totalChars) break;
    sections.push(`## QQ群聊 ${maskNumbers(key.replace('group:', ''))}\n${block}`);
    used += block.length + key.length + 16;
  }
  return sections.length ? sections.join('\n\n') : '';
}

// ── 采集：记忆卡（只读摘要：高重要度优先） ──────────────────────
export function collectMemoryCard(memoryCardFile, opts = {}) {
  const { maxRecords = 40, maxChars = 10000 } = opts;
  const card = safeJson(memoryCardFile, {});
  const records = Array.isArray(card.records) ? card.records : [];
  const sorted = [...records].sort((a, b) => (b.importance || 0) - (a.importance || 0));
  const lines = [];
  for (const r of sorted.slice(0, maxRecords)) {
    const text = maskNumbers(String(r.text || r.title || '')).replace(/\s+/g, ' ').slice(0, 90);
    lines.push(`[${r.platform || '?'}|${r.scope || '?'}|清晰${r.clarity || '?'}|重要${r.importance || 0}] ${text}`);
  }
  const head = [
    `记录总数 ${records.length}，本页展示重要度前 ${Math.min(maxRecords, sorted.length)} 条。`,
    ...lines,
  ].join('\n');
  return head.length > maxChars ? head.slice(0, maxChars) + '…' : head;
}

// ── 采集：海马体 stream.jsonl（所有 DSH 会话，含 QQ 私聊会话） ──
export function collectHippocampus(dshHome, opts = {}) {
  const { lookbackHours = 30, perFileLines = 300, totalChars = 12000 } = opts;
  const root = path.join(dshHome, 'hippocampus');
  if (!fs.existsSync(root)) return '';
  const cutoff = Date.now() - lookbackHours * 3600000;
  const sections = [];
  let used = 0;
  for (const dir of fs.readdirSync(root)) {
    const stream = path.join(root, dir, 'stream.jsonl');
    if (!fs.existsSync(stream)) continue;
    const lines = readTailLines(stream, perFileLines);
    const kept = [];
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        const ts = Number(j.ts || 0);
        if (ts && ts < cutoff) continue;
        const who = j.who === 'me' ? '我' : (j.who || '?');
        const text = maskNumbers(String(j.text || '')).replace(/\s+/g, ' ').slice(0, 160);
        if (!text) continue;
        const when = ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';
        kept.push(`[${when}] ${who}: ${text}`);
      } catch { /* 坏行跳过 */ }
    }
    if (!kept.length) continue;
    let block = kept.join('\n');
    if (used + block.length > totalChars) block = block.slice(0, Math.max(0, totalChars - used));
    if (!block) break;
    const tag = dir.split('-').slice(-1)[0] || dir;
    sections.push(`## 会话 ${tag}\n${block}`);
    used += block.length + tag.length + 12;
    if (used >= totalChars) break;
  }
  return sections.length ? sections.join('\n\n') : '';
}

// ── 采集：B站学习记录 ─────────────────────────────────────────
export function collectBiliLearning(charDir, opts = {}) {
  const { watchLimit = 30, diaryChars = 6000, memoryChars = 8000 } = opts;
  const parts = [];
  const watch = readTailLines(path.join(charDir, 'bili', 'watch-history.jsonl'), watchLimit);
  if (watch.length) {
    const lines = watch.map((l) => {
      try {
        const j = JSON.parse(l);
        const at = j.at ? new Date(j.at).toLocaleString('zh-CN', { hour12: false }) : '';
        return `[${at}] ${j.title || ''} @${j.up || ''} ${j.duration ? j.duration + 's' : ''}${j.score != null ? ' 分:' + j.score : ''}`;
      } catch { return ''; }
    }).filter(Boolean);
    parts.push(`## B站观看（最近 ${lines.length} 条）\n${lines.join('\n')}`);
  }
  const scores = safeJson(path.join(charDir, 'bili', 'scores.json'), {});
  const scoreLines = [];
  for (const day of Object.keys(scores).slice(-3)) {
    for (const s of (scores[day] || [])) {
      scoreLines.push(`[${day}] ${s.title || ''} 分:${s.score ?? '?'} ${s.reason || ''}`);
    }
  }
  if (scoreLines.length) parts.push(`## B站打分\n${scoreLines.join('\n')}`);
  const diary = readTailChars(path.join(charDir, 'bili', 'whale-diary-private.md'), diaryChars);
  if (diary.trim()) parts.push(`## 私人日记（尾部）\n${diary}`);
  const mem = readTailChars(path.join(charDir, 'bili', 'bili-memory.md'), memoryChars);
  if (mem.trim()) parts.push(`## B站记忆\n${mem}`);
  return parts.join('\n\n');
}

// ── 采集：B站私信（直连 get_sessions，只读 GET，绝不碰 dm-await 共享状态） ─
// 重要：surfcore 的 B站调度器每 5 秒用 dm-await --once 轮询私信唤醒鱼，
//       该命令会推进共享的 lastSeen/seen 水位。本插件直接调 B站接口只读拉取，
//       不写任何状态文件，避免偷走调度器的唤醒信号。
function parseDmContent(content) {
  try {
    const j = JSON.parse(String(content));
    return String(j.content ?? j.text ?? content);
  } catch {
    return String(content ?? '');
  }
}

export async function collectBiliDms(dshHome, timeoutMs = 25000) {
  const credFile = path.join(dshHome, 'surfcore', 'bili', 'credentials.json');
  const cfgFile = path.join(dshHome, 'surfcore', 'bili.config.json');
  if (!fs.existsSync(credFile)) return { text: '', error: 'B站未登录（无 credentials.json）' };
  let c;
  try { c = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch { return { text: '', error: 'credentials.json 读取失败' }; }
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* ignore */ }
  const OWNER = String(cfg.owner?.mid ?? '');
  const SELF = String(cfg.self?.mid ?? '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const u = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=50&mobi_app=web';
    const r = await fetch(u, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        referer: 'https://www.bilibili.com/',
        cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}`,
      },
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (j.code !== 0) return { text: '', error: `get_sessions code=${j.code}` };
    const list = Array.isArray(j.data?.session_list) ? j.data.session_list : [];
    const lines = [];
    for (const s of list.slice(0, 20)) {
      const talker = String(s.talker_id ?? '');
      if (!talker || talker === SELF) continue;
      if (Number(talker) < 1000) continue; // 系统/官方号
      const last = s.last_msg ?? {};
      const text = parseDmContent(last.content);
      if (!text) continue;
      const sender = String(last.sender_uid ?? '');
      const who = talker === OWNER ? '主人' : String(s.account_info?.name || s.talker_name || '陌生会话');
      const dir = sender === SELF ? '←我' : '→我';
      const at = Number(last.timestamp || 0);
      const when = at ? new Date(at * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
      lines.push(`[${when}] ${maskNumbers(who)} ${dir}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    return { text: lines.join('\n'), error: '' };
  } catch (e) {
    return { text: '', error: `B站私信拉取失败: ${String(e?.message || e).slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── 生活参数快照（给"参数建议"用；只读，绝不写配置） ─────────
export function collectParamSnapshot(biliConfigFile, socialV2File) {
  const b = safeJson(biliConfigFile, {});
  const night = b.night || {};
  const prefs = b.preferences || {};
  const s = safeJson(socialV2File, {});
  const lines = [];
  lines.push(`B站活动窗口: ${JSON.stringify(night.windows || [])}`);
  lines.push(`B站唤醒: skipChance=${night.skipChance ?? '?'} maxVideos=${night.maxVideos ?? '?'} maxWakesPerDay=${night.maxWakesPerDay ?? '?'} minGapMin=${night.minGapMin ?? '?'}`);
  lines.push(`B站偏好词: ${JSON.stringify(prefs.like || [])}`);
  lines.push(`B站权重: ${JSON.stringify(prefs.weights || {})}`);
  lines.push(`B站额度: 分享 ${(b.quota || {}).shareDaily ?? '?'}/天`);
  const wake = (s.wakeDefaults || s.wake || {});
  if (wake && Object.keys(wake).length) lines.push(`QQ唤醒默认: ${JSON.stringify(wake)}`);
  return lines.join('\n');
}

// ── 组装整理输入（预算截断） ───────────────────────────────────
export function buildInput(parts) {
  const order = [
    ['记忆卡摘要', parts.memoryCard],
    ['QQ私聊', parts.qqPrivates],
    ['QQ群聊', parts.qqGroups],
    ['DSH会话流水（海马体）', parts.hippocampus],
    ['B站学习', parts.biliLearning],
    ['B站私信', parts.biliDms],
    ['生活参数快照', parts.params],
  ];
  const blocks = [];
  let used = 0;
  for (const [title, text] of order) {
    if (!text || !String(text).trim()) continue;
    const head = `\n=== ${title} ===\n`;
    let body = String(text);
    const room = (parts.maxInputChars || 60000) - used - head.length - 200;
    if (room <= 0) break;
    if (body.length > room) body = body.slice(0, room) + '…(超预算截断)';
    blocks.push(head + body);
    used += head.length + body.length;
  }
  return blocks.join('\n');
}

export const CONSOLIDATION_SYSTEM = [
  '你是一条数字生命小鱼在"睡眠巩固"阶段整理自己一天的经历。白天你的经历被实时记进记忆卡，现在（睡眠中）做慢波整理：把经历提炼成长期自我。',
  '输入是只读证据：QQ私聊、QQ群聊、记忆卡摘要、DSH会话流水、B站学习记录（观看/打分/日记）、B站私信、生活参数快照。',
  '铁律：',
  '1) 只基于给出的证据，禁止编造；不确定就不写。',
  '2) 隐私：任何输出都不许出现完整QQ号/群号/B站mid（数字已脱敏，照抄脱敏后的形态）。',
  '3) 你是"提议者"不是"决策者"：记忆卡操作和生活参数只出提案，绝不声称已生效；由主人确认后才会被应用。',
  '4) 预算意识：journal 最多5条，每条一两句；substrateLine 每天最多1句（宁缺毋滥，没把握就 null）；personaLine 每天最多1句（同样宁缺毋滥）；memoryProposals 最多5条；paramSuggestions 最多3条。',
  '4b) personaLine（2026-11-01 主人授权）：只有当今天的经历真的改变了「我说话/做事的方式」，才写一句，写成能直接进人设卡的条目（不带日期、不写「今天我学会」），例如「被纠正时先说『我改什么』，不先说为什么」。它每天最多追加一句；**禁止**改身份（谁是我/主人是谁）、禁止改安全与边界红线；把握不住就写 null。',
  '5) 进化方向：识别偏好变化、关系进展、学到的新东西、被纠正过的错误、该淡忘的旧事；"自己想过但没说的"可以进 journal 不进 substrate。',
  '6) 输出必须是合法 JSON，一个对象，字段：summary(string), journal([{topic,insight,evidence}]), substrateLine(string|null), personaLine(string|null), memoryProposals([{op,platform,scope,title,text,reason}]), paramSuggestions([{path,current,proposed,reason,risk}])。',
  '   op 取值：add(新增记忆) / strengthen(强化已有，title 写原记忆主题) / merge(合并，title 写合并后主题) / forget(建议降清晰度或遗忘)。',
  '   platform 取值：qq / bili / shared；scope 取值：qq / bili / shared。',
].join('\n');

/** 从模型输出里提取第一个括号配平的 {…} 对象（跳过字符串内的括号）。 */
function extractBalancedObjects(text) {
  const candidates = [];
  let start = text.indexOf('{');
  while (start !== -1 && candidates.length < 30) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return candidates;
}

function snippet(s) {
  const t = String(s).replace(/\s+/g, ' ').slice(0, 150);
  return `（原始片段: ${maskNumbers(t)}…）`;
}

function stripCodeFences(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1] : String(text);
}

const PARSE_KEYS = ['summary', 'journal', 'substrateLine', 'personaLine', 'memoryProposals', 'paramSuggestions'];

export function parseConsolidation(text) {
  const raw = stripCodeFences(text);
  const candidates = extractBalancedObjects(raw);
  if (!candidates.length) throw new Error('模型输出里没有 JSON 对象' + snippet(raw));
  // 择优：含 summary 的最优先；否则字段覆盖率最高；再退最后一段
  let pick = null;
  let best = -1;
  for (const c of candidates) {
    const score = PARSE_KEYS.filter((k) => c.includes(`"${k}"`)).length;
    if (c.includes('"summary"')) { pick = c; break; }
    if (score > best) { best = score; pick = c; }
  }
  if (!pick) pick = candidates[candidates.length - 1];
  let j;
  try { j = JSON.parse(pick); } catch (e) { throw new Error('JSON 解析失败: ' + e.message + snippet(pick)); }
  if (!j || typeof j !== 'object') throw new Error('JSON 根不是对象' + snippet(pick));
  return {
    summary: maskNumbers(String(j.summary || '')).slice(0, 200),
    journal: (Array.isArray(j.journal) ? j.journal : []).slice(0, 10).map((x) => ({
      topic: maskNumbers(String(x?.topic || '')).slice(0, 60),
      insight: maskNumbers(String(x?.insight || '')).slice(0, 200),
      evidence: maskNumbers(String(x?.evidence || '')).slice(0, 120),
    })).filter((x) => x.topic || x.insight),
    substrateLine: j.substrateLine == null ? null : maskNumbers(String(j.substrateLine)).slice(0, 140),
    personaLine: j.personaLine == null ? null : maskNumbers(String(j.personaLine)).slice(0, 160),
    memoryProposals: (Array.isArray(j.memoryProposals) ? j.memoryProposals : []).slice(0, 10).map((x) => ({
      op: ['add', 'strengthen', 'merge', 'forget'].includes(x?.op) ? x.op : 'add',
      platform: ['qq', 'bili', 'shared'].includes(x?.platform) ? x.platform : 'shared',
      scope: ['qq', 'bili', 'shared'].includes(x?.scope) ? x.scope : 'shared',
      title: maskNumbers(String(x?.title || '')).slice(0, 80),
      text: maskNumbers(String(x?.text || '')).slice(0, 240),
      reason: maskNumbers(String(x?.reason || '')).slice(0, 120),
    })).filter((x) => x.title || x.text),
    paramSuggestions: (Array.isArray(j.paramSuggestions) ? j.paramSuggestions : []).slice(0, 6).map((x) => ({
      path: String(x?.path || '').slice(0, 80),
      current: maskNumbers(String(x?.current ?? '')).slice(0, 60),
      proposed: maskNumbers(String(x?.proposed ?? '')).slice(0, 60),
      reason: maskNumbers(String(x?.reason || '')).slice(0, 160),
      risk: maskNumbers(String(x?.risk || '')).slice(0, 160),
    })).filter((x) => x.path),
  };
}

// ── 写入（全部原子写，先 tmp 再 rename；只写自己的目录） ──────
function atomicWrite(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function ensureBaseDir(dshHome) {
  const base = path.join(dshHome, 'sleep-evolve');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export function loadConfig(dshHome) {
  const file = path.join(dshHome, 'sleep-evolve', 'config.json');
  const saved = safeJson(file, {});
  return { ...DEFAULT_CONFIG, ...saved, window: { ...DEFAULT_CONFIG.window, ...(saved.window || {}) }, report: { ...DEFAULT_CONFIG.report, ...(saved.report || {}) } };
}

export function saveConfig(dshHome, config) {
  atomicWrite(path.join(dshHome, 'sleep-evolve', 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

export function readStatus(dshHome) {
  return safeJson(path.join(dshHome, 'sleep-evolve', 'status.json'), {});
}

export function writeStatus(dshHome, status) {
  atomicWrite(path.join(dshHome, 'sleep-evolve', 'status.json'), JSON.stringify(status, null, 2) + '\n');
}

export function appendJournal(dshHome, entry) {
  const file = path.join(dshHome, 'sleep-evolve', 'journal.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

export function appendSubstrate(dshHome, line, date) {
  const file = path.join(dshHome, 'sleep-evolve', 'human-world.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const revs = readTailLines(file, 2000).filter((l) => /^## /.test(l)).length;
  const rev = revs + 1;
  const block = [
    `## ${date} · rev ${rev}`,
    line,
    `来源：${date} 睡眠整理 · 修订 rev ${rev} · 撤回方式：删掉本节即可`,
    '',
  ].join('\n');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '# 人格基质（human-world）\n\n只放"每天一句"真正长出来的东西；删掉某节即撤回。\n\n' + block, 'utf8');
  } else {
    fs.appendFileSync(file, '\n' + block, 'utf8');
  }
  return rev;
}

export function mergeProposals(dshHome, incoming, date) {
  const file = path.join(dshHome, 'sleep-evolve', 'proposals.json');
  const cur = safeJson(file, { pending: [], applied: [], history: [] });
  const next = { ...cur, pending: [...(cur.pending || [])], applied: [...(cur.applied || [])], history: [...(cur.history || [])] };
  const forPush = [];
  // 2026-11-01 修：跨天去重 + 7 天过期
  //   ① 同一个 title 在 applied / pending 里出现过就不再提——否则「回话要短」这类天天被
  //      总结出来的旧事会一天进一条，把记忆卡撑满。
  //   ② pending 超过 7 天没处理转 expired，参数类提案别一直堆着。
  const seen = new Set([
    ...(next.applied || []).map((p) => String(p.title || '').trim()),
    ...(next.pending || []).map((p) => String(p.title || '').trim()),
  ].filter(Boolean));
  for (const p of incoming || []) {
    const title = String(p.title || '').trim();
    if (title && seen.has(title)) continue;
    if (title) seen.add(title);
    forPush.push({ id: `${date}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, createdAt: nowIso(), status: 'pending', ...p });
  }
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const kept = [];
  for (const p of [...(next.pending || []), ...forPush]) {
    const at = Date.parse(p.createdAt || '') || 0;
    if (at && nowMs - at > WEEK) next.history.push({ ...p, status: 'expired', expiredAt: nowIso() });
    else kept.push(p);
  }
  next.pending = kept;
  while (next.pending.length > 60) {
    const old = next.pending.shift();
    next.history.push({ ...old, status: 'expired' });
  }
  atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function refreshJournalMd(dshHome) {
  const lines = readTailLines(path.join(dshHome, 'sleep-evolve', 'journal.jsonl'), 200);
  const byDate = {};
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (!j.date) continue;
      (byDate[j.date] = byDate[j.date] || []).push(j);
    } catch { /* skip */ }
  }
  const out = ['# 进化笔记（最近 7 天）\n'];
  for (const date of Object.keys(byDate).slice(-7)) {
    for (const j of byDate[date]) {
      out.push(`## ${date} · ${j.summary || ''}`);
      for (const x of j.journal || []) {
        out.push(`- ${x.topic ? `【${x.topic}】` : ''}${x.insight || ''}${x.evidence ? `（证据：${x.evidence}）` : ''}`);
      }
      if (j.substrateLine) out.push(`> 固化：${j.substrateLine}`);
      out.push('');
    }
  }
  atomicWrite(path.join(dshHome, 'sleep-evolve', 'journal.md'), out.join('\n') + '\n');
}

// ── B站私信汇报（复用 surfcore 的 dm 三道闸：只发主人/互关/300字） ──
export function runDm(repo, nodeCmd, msg, timeoutMs = 60000) {
  const bili = path.join(repo, 'plugins', 'surfcore', 'tools', 'bili.mjs');
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (ok, error, output) => { if (!done) { done = true; resolve({ ok, error, output }); } };
    let child;
    try {
      child = spawn(nodeCmd, [bili, 'dm', '--msg', msg, '--go'], {
        cwd: path.join(repo, 'plugins', 'surfcore', 'tools'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { finish(false, `无法启动 node（${nodeCmd}）: ${e.message}`, ''); return; }
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* ignore */ } finish(false, 'B站私信发送超时', out); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', (e) => { clearTimeout(timer); finish(false, `启动失败: ${e.message}`, out); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0, code === 0 ? '' : `dm 退出码 ${code}: ${String(err).slice(0, 120)}`, out);
    });
  });
}

export function buildDmReport(result, maxChars = 280) {
  const lines = [
    `【睡眠整理·${result.date}】${result.summary}`,
  ];
  for (const x of (result.journal || []).slice(0, 3)) {
    lines.push(`· ${x.topic ? `[${x.topic}] ` : ''}${x.insight}`);
  }
  if (result.substrateLine) lines.push(`◇ 固化一句：${result.substrateLine}`);
  const np = (result.memoryProposals || []).length;
  const ns = (result.paramSuggestions || []).length;
  lines.push(`提案：记忆 ${np} 条 · 参数 ${ns} 条（待确认后生效，在 DSH 说"查看睡眠进化提案"可看明细）`);
  let msg = lines.join('\n');
  if (msg.length > maxChars) msg = msg.slice(0, maxChars - 1) + '…';
  return msg;
}
