const { acquireExclusiveLease } = require('../../platform/durability');

const lockPath = process.argv[2];
if (!lockPath) throw new Error('lock path is required');

const lease = acquireExclusiveLease(lockPath);
process.stdout.write('acquired\n');

const releaseAndExit = () => {
  if (lease.isHeld()) lease.release();
  process.exit(0);
};

process.on('SIGTERM', releaseAndExit);
process.on('SIGINT', releaseAndExit);
setInterval(() => {}, 60_000);
