const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const name of ['smoke', 'adversarial', 'dm-api', 'edge-cases', 'wheel', 'embed']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, `${name}-test.cjs`)], {
    stdio: 'inherit', env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
