const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { publishGeneratedProjectFile } = require('../project-export');

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('generated exports publish only while their starting project incarnation is current', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-project-export-'));
  const finalPath = path.join(tempDir, 'novel.epub');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(finalPath, 'replacement-project-export');
  let currentInstance = 'old-instance';
  const generationStarted = deferred();
  const finishGeneration = deferred();
  const staleError = Object.assign(new Error('project was replaced'), {
    code: 'PROJECT_INSTANCE_MISMATCH',
  });

  const stalePublication = publishGeneratedProjectFile({
    finalPath,
    createId: () => 'stale-task',
    generate: async (tempPath) => {
      fs.writeFileSync(tempPath, 'old-instance-export');
      generationStarted.resolve();
      await finishGeneration.promise;
    },
    assertCurrent: () => {
      if (currentInstance !== 'old-instance') throw staleError;
    },
  });

  await generationStarted.promise;
  currentInstance = 'replacement-instance';
  finishGeneration.resolve();
  await assert.rejects(stalePublication, (error) => error === staleError);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'replacement-project-export');
  assert.equal(fs.existsSync(path.join(tempDir, '.novel.epub.stale-task.tmp')), false);

  await publishGeneratedProjectFile({
    finalPath,
    createId: () => 'current-task',
    generate: async (tempPath) => fs.writeFileSync(tempPath, 'current-instance-export'),
    assertCurrent: () => assert.equal(currentInstance, 'replacement-instance'),
  });
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'current-instance-export');
  assert.equal(fs.existsSync(path.join(tempDir, '.novel.epub.current-task.tmp')), false);
});

test('concurrent callers capture their own bytes before the shared artifact can be replaced', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-concurrent-export-'));
  const finalPath = path.join(tempDir, 'novel.epub');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const finishFirst = deferred();
  const finishSecond = deferred();

  const first = publishGeneratedProjectFile({
    finalPath,
    createId: () => 'first',
    generate: async (tempPath) => {
      fs.writeFileSync(tempPath, 'first-snapshot');
      await finishFirst.promise;
    },
    assertCurrent: () => {},
    capturePublished: publishedPath => fs.readFileSync(publishedPath, 'utf8'),
  });
  const second = publishGeneratedProjectFile({
    finalPath,
    createId: () => 'second',
    generate: async (tempPath) => {
      fs.writeFileSync(tempPath, 'second-snapshot');
      await finishSecond.promise;
    },
    assertCurrent: () => {},
    capturePublished: publishedPath => fs.readFileSync(publishedPath, 'utf8'),
  });

  finishFirst.resolve();
  finishSecond.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first-snapshot', 'second-snapshot']);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'second-snapshot');
});
