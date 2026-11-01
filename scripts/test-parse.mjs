import { parseConsolidation } from '../lib/engine.js';

const cases = [
  ['后缀杂音', '思考：{"a":1} 结果：{"summary":"今天很好","journal":[{"topic":"t","insight":"i"}],"substrateLine":"一句","memoryProposals":[],"paramSuggestions":[]} 收尾说明'],
  ['代码围栏', '```json\n{"summary":"s2","journal":[]}\n```'],
  ['前后杂音', '前缀{"summary":"s3","journal":[]}后缀{"x":1}'],
  ['两个JSON', '{"summary":"first","journal":[]} {"summary":"second","journal":[],"substrateLine":"L2"}'],
  ['字符串含花括号', '{"summary":"括号{内}嵌套","journal":[]}'],
];
let pass = 0;
for (const [name, input] of cases) {
  try {
    const p = parseConsolidation(input);
    const ok = p.summary && p.summary.length > 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: summary=${p.summary}`);
    if (ok) pass++;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
