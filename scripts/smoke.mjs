// 冒烟测试：只读采集 + 解析 + 预算，不写任何文件、不发消息。
import {
  resolveDshHome, resolveSurfcoreRepo, resolveNodeCmd, loadConfig,
  inWindow, qqActiveRecently,
  collectQqPrivates, collectQqGroups, collectMemoryCard, collectHippocampus, collectBiliLearning,
  collectParamSnapshot, buildInput, parseConsolidation, maskNumbers,
} from '../lib/engine.js';

const dshHome = resolveDshHome();
const repo = resolveSurfcoreRepo(dshHome, 'F:/feiyu/surfcore');
console.log('dshHome:', dshHome);
console.log('repo:', repo);
console.log('nodeCmd:', resolveNodeCmd(''));

const charDir = `${dshHome}/surfcore/characters/char-mvujk06p`;
const socialV2 = `${repo}/state/social-v2.json`;
const biliConfig = `${dshHome}/surfcore/bili.config.json`;

const parts = {
  maxInputChars: 60000,
  memoryCard: collectMemoryCard(`${charDir}/memory/memory-card.json`),
  qqPrivates: collectQqPrivates(socialV2, { lookbackHours: 30 }),
  qqGroups: collectQqGroups(socialV2, { lookbackHours: 30 }),
  hippocampus: collectHippocampus(dshHome, { lookbackHours: 30 }),
  biliLearning: collectBiliLearning(charDir),
  biliDms: '',
  params: collectParamSnapshot(biliConfig, socialV2),
};
for (const [k, v] of Object.entries(parts)) {
  if (k === 'maxInputChars') continue;
  console.log(`${k}: ${String(v).length} chars`);
}
const input = buildInput(parts);
console.log('input total:', input.length, 'chars');

const p = parseConsolidation(JSON.stringify({
  summary: '今天学会了1234567890这种长数字要打码',
  journal: [{ topic: '口语', insight: '接话前先给具体的一句', evidence: '私聊里他说想听具体的' }],
  substrateLine: '把话头递回去，比报片名更重要',
  memoryProposals: [{ op: 'add', platform: 'qq', scope: 'qq', title: '主人喜欢具体', text: '问在看什么=想听具体内容', reason: '两次类似互动' }],
  paramSuggestions: [{ path: 'night.windows[0].wakes', current: '1', proposed: '2', reason: '想多看', risk: '额度' }],
}));
console.log('parse ok:', JSON.stringify(p).slice(0, 200));
console.log('masked:', maskNumbers('QQ 3244612527 和 mid 3546859985438860'));
console.log('window now:', inWindow(new Date(), '00:10', '05:30'));
console.log('qqActiveRecently:', qqActiveRecently(socialV2, 60));
console.log('SMOKE OK');
