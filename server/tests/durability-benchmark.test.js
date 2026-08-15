const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

const { openControlStore } = require('../control-store');
const { createAtomicStore } = require('../sqljs-atomic-store');
const { getWasmBinary } = require('../wasm-binary');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

const CHAPTER_COUNT = 3_000;
const CHAPTER_CONTENT = '墨'.repeat(3_400);
const MEASURED_SAMPLES = 20;
const WARMUP_SAMPLES = 2;
const benchmark = process.env.MYTHPEN_RUN_DURABILITY_BENCHMARK === '1' ? test : test.skip;

function nearestRank(orderedSamples, percentile) {
  return orderedSamples[Math.ceil(orderedSamples.length * percentile) - 1];
}

function summarizeSamples(samples) {
  assert.ok(samples.length > 0, 'benchmark samples must not be empty');
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    maxMs: Number(ordered[ordered.length - 1].toFixed(2)),
    p50Ms: Number(nearestRank(ordered, 0.5).toFixed(2)),
    p95Ms: Number(nearestRank(ordered, 0.95).toFixed(2)),
  };
}

test('benchmark summaries report nearest-rank p50 and p95 plus max', () => {
  const samples = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.deepEqual(summarizeSamples(samples), {
    maxMs: 20,
    p50Ms: 10,
    p95Ms: 19,
  });
});

function benchmarkResult(name, samples, databaseBytes) {
  const result = {
    chapterCount: CHAPTER_COUNT,
    databaseMiB: Number((databaseBytes / (1024 * 1024)).toFixed(2)),
    measuredSamples: samples.length,
    name,
    ...summarizeSamples(samples),
    runtime: `Bun ${process.versions.bun}`,
    host: `${os.platform()} ${os.release()} | ${os.cpus()[0]?.model || 'unknown CPU'} | ${Math.round(os.totalmem() / (1024 ** 3))} GiB RAM`,
    sampleMs: samples.map((sample) => Number(sample.toFixed(2))),
    warmupSamples: WARMUP_SAMPLES,
  };
  process.stdout.write(`MYTHPEN_DURABILITY_BENCHMARK ${JSON.stringify(result)}\n`);
  return result;
}

async function loadSqlModule() {
  const initSqlJs = require('sql.js');
  return initSqlJs({ wasmBinary: getWasmBinary() });
}

function createRawBenchmarkDatabase(SQL, filePath) {
  const database = new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  database.run('CREATE TABLE chapters (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
  database.run('BEGIN');
  const insert = database.prepare('INSERT INTO chapters (id, content) VALUES (?, ?)');
  try {
    for (let id = 1; id <= CHAPTER_COUNT; id += 1) insert.run([id, CHAPTER_CONTENT]);
  } finally {
    insert.free();
  }
  database.run('COMMIT');
  fs.writeFileSync(filePath, Buffer.from(database.export()));
  database.close();
}

benchmark('3,000-chapter full AtomicStore publish stays below the L1 p95 target', {
  timeout: 120_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-publish-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'benchmark.mythpen.db');
  const controlDir = path.join(root, 'control');
  const SQL = await loadSqlModule();
  createRawBenchmarkDatabase(SQL, dbPath);
  const databaseBytes = fs.statSync(dbPath).size;
  assert.ok(databaseBytes >= 25 * 1024 * 1024, 'fixture must remain approximately 30 MiB');
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const samples = [];
  for (let index = 0; index < WARMUP_SAMPLES + MEASURED_SAMPLES; index += 1) {
    const connection = store.currentConnection();
    connection.run('UPDATE chapters SET content = ? WHERE id = 1', [
      `${CHAPTER_CONTENT.slice(0, -1)}${index % 10}`,
    ]);
    const startedAt = performance.now();
    store.publish(connection);
    const elapsed = performance.now() - startedAt;
    if (index >= WARMUP_SAMPLES) samples.push(elapsed);
  }
  const result = benchmarkResult('full AtomicStore publish', samples, databaseBytes);
  assert.ok(
    result.p95Ms < 500,
    `full database publish p95 ${result.p95Ms}ms exceeded the 500ms L1 target`,
  );
  assert.equal(
    store.currentConnection().exec('SELECT COUNT(*) FROM chapters')[0].values[0][0],
    CHAPTER_COUNT,
  );
  store.close();
});

benchmark('3,000-chapter project save end-to-end stays below the L1 p95 target', {
  timeout: 120_000,
}, async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  const { writeChapterBody } = require('../manuscript-service');
  await db.initDatabase();
  const project = 'durability-benchmark';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  withRawManuscriptSetup(() => projectDb.transaction(() => {
    projectDb.prepare(
      "INSERT INTO volumes (id, sort_order, title, summary) VALUES (1, 1, 'Benchmark', '')",
    ).run();
    const insert = projectDb.prepare(
      'INSERT INTO chapters (volume_id, num, title, content, word_count) VALUES (1, ?, ?, ?, ?)',
    );
    for (let chapter = 1; chapter <= CHAPTER_COUNT; chapter += 1) {
      insert.run(chapter, `Chapter ${chapter}`, CHAPTER_CONTENT, CHAPTER_CONTENT.length);
    }
  })());
  const databaseBytes = fs.statSync(projectPath).size;
  assert.ok(databaseBytes >= 25 * 1024 * 1024, 'fixture must remain approximately 30 MiB');

  const samples = [];
  for (let index = 0; index < WARMUP_SAMPLES + MEASURED_SAMPLES; index += 1) {
    const startedAt = performance.now();
    const result = writeChapterBody({
      projectName: project,
      chapterId: 1,
      content: `${CHAPTER_CONTENT.slice(0, -1)}${index % 10}`,
      source: 'rest',
    });
    const elapsed = performance.now() - startedAt;
    assert.equal(result.changes, 1);
    if (index >= WARMUP_SAMPLES) samples.push(elapsed);
  }
  const result = benchmarkResult('project save end-to-end', samples, databaseBytes);
  assert.ok(
    result.p95Ms < 300,
    `project save p95 ${result.p95Ms}ms exceeded the 300ms L1 target`,
  );
  assert.equal(
    projectDb.prepare('SELECT COUNT(*) AS count FROM chapters').get().count,
    CHAPTER_COUNT,
  );
});
