const { createProjectWriteCoordinator } = require('../../project-write-coordinator');

const [mode, lockRoot, projectPath] = process.argv.slice(2);
if (!['hold', 'once'].includes(mode) || !lockRoot || !projectPath) {
  throw new Error('usage: project-write-worker.js <hold|once> <lockRoot> <projectPath>');
}

const coordinator = createProjectWriteCoordinator({
  lockRoot,
  recoverProject: () => {
    process.stdout.write('recover\n');
  },
});

async function main() {
  try {
    await coordinator.withProjectWrite(projectPath, async () => {
      process.stdout.write('callback\n');
      if (mode === 'hold') {
        setInterval(() => {}, 60_000);
        await new Promise(() => {});
      }
    });
    process.stdout.write('completed\n');
  } catch (error) {
    process.stdout.write(`error:${error.code || 'UNKNOWN'}\n`);
    if (error.code !== 'PROJECT_WRITE_BUSY') process.exitCode = 1;
  }
}

main();
