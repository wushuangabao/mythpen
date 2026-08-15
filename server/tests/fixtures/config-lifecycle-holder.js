const { acquireConfigLifecycleLease } = require('../../config-lifecycle-lease');

const [configDbPath, controlRoot] = process.argv.slice(2);
if (!configDbPath || !controlRoot) throw new Error('config path and control root are required');

acquireConfigLifecycleLease(configDbPath, { controlRoot });
process.stdout.write('acquired\n');
setInterval(() => {}, 60_000);
