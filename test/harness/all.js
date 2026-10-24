// すべてのハーネススイートを順に実行する。
//   node test/harness/all.js
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const SUITES = ['core.js', 'setup.js', 'inventory.js', 'product.js', 'backup.js', 'webactions.js'];

let failed = 0;
for (const f of SUITES) {
  console.log('\n=== ' + f + ' ===');
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (e) {
    failed++;
    process.stdout.write(e.stdout || '');
    process.stderr.write(e.stderr || '');
  }
}

console.log('');
if (failed) {
  console.log(`✗ ${failed} / ${SUITES.length} スイートが失敗しました`);
  process.exit(1);
}
console.log(`✓ 全 ${SUITES.length} スイート合格`);
