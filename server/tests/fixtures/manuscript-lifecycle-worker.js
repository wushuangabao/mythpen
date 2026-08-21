'use strict';

const {
  createWindowsManuscriptLifecycleLeaseAdapter,
} = require('../../platform/windows-manuscript-lifecycle-lease');

function freezePhysicalIdentity(value) {
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function parseExpectedIdentity(encoded) {
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  return Object.freeze({
    canonicalRealControlDirectory: value.canonicalRealControlDirectory,
    controlDirectoryIdentity: freezePhysicalIdentity(value.controlDirectoryIdentity),
    controlParentDirectoryIdentity: freezePhysicalIdentity(
      value.controlParentDirectoryIdentity,
    ),
    lifecycleLockIdentity: freezePhysicalIdentity(value.lifecycleLockIdentity),
  });
}

const platformIdentity = parseExpectedIdentity(process.argv[2]);
const mode = process.argv[3];

try {
  const adapter = createWindowsManuscriptLifecycleLeaseAdapter();
  const lease = mode === 'exclusive'
    ? adapter.acquireExclusive(platformIdentity)
    : adapter.acquireShared(platformIdentity);
  process.stdout.write('acquired\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (!chunk.split(/\r?\n/).includes('release')) return;
    lease.release();
    process.exit(0);
  });
  process.stdin.resume();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
}
