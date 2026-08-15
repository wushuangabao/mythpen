const fs = require('node:fs');

const { openControlStore } = require('../../control-store');

const [controlDir, releasePath] = process.argv.slice(2);
if (!controlDir || !releasePath) {
  throw new Error('usage: control-store-contention-worker.js <controlDir> <releasePath>');
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));
let barrierReached = false;
const event = new Proxy(
  { type: 'child.append', payload: { process: 'child' } },
  {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'type' && !barrierReached) {
        barrierReached = true;
        process.stdout.write('barrier\n');
        while (!fs.existsSync(releasePath)) Atomics.wait(waitCell, 0, 0, 20);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  },
);

try {
  const appended = openControlStore(controlDir).append(event);
  process.stdout.write(`appended:${appended.digest}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
