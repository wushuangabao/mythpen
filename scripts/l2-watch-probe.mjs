#!/usr/bin/env bun

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROBE_VERSION = 3;
const EVENT_SAMPLE_LIMIT = 120;

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    overflowCount: 20_000,
    externalCount: 5_000,
    pacedCount: 1_000,
    pacedDelayMilliseconds: 2,
    sameFileWrites: 2_000,
    atomicIterations: 20,
    keep: false,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep') {
      options.keep = true;
    } else if (argument === '--overflow-count') {
      options.overflowCount = parsePositiveInteger(argv[++index], options.overflowCount, argument);
    } else if (argument === '--same-file-writes') {
      options.sameFileWrites = parsePositiveInteger(argv[++index], options.sameFileWrites, argument);
    } else if (argument === '--external-count') {
      options.externalCount = parsePositiveInteger(argv[++index], options.externalCount, argument);
    } else if (argument === '--paced-count') {
      options.pacedCount = parsePositiveInteger(argv[++index], options.pacedCount, argument);
    } else if (argument === '--paced-delay-ms') {
      options.pacedDelayMilliseconds = parseNonNegativeInteger(
        argv[++index],
        options.pacedDelayMilliseconds,
        argument,
      );
    } else if (argument === '--atomic-iterations') {
      options.atomicIterations = parsePositiveInteger(argv[++index], options.atomicIterations, argument);
    } else if (argument === '--output') {
      const output = argv[++index];
      if (!output) throw new Error('--output requires a path');
      options.output = path.resolve(output);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function writeDistinctFiles(directory, prefix, count) {
  for (let index = 0; index < count; index += 1) {
    const basename = `${prefix}${String(index).padStart(6, '0')}.tmp`;
    writeFileSync(path.join(directory, basename), 'x');
  }
}

function sleepSynchronously(milliseconds) {
  if (milliseconds <= 0) return;
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

function runInternalWriter(argv) {
  if (argv[0] !== '--internal-distinct-writer') return false;
  if (argv.length !== 5) throw new Error('Internal writer arguments are invalid');
  const directory = path.resolve(argv[1]);
  const prefix = argv[2];
  const count = parsePositiveInteger(argv[3], null, 'internal writer count');
  const delayMilliseconds = parseNonNegativeInteger(argv[4], null, 'internal writer delay');
  if (!/^[a-z0-9_]+$/.test(prefix) || !existsSync(directory)) {
    throw new Error('Internal writer target is invalid');
  }
  const startedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    const basename = `${prefix}${String(index).padStart(6, '0')}.tmp`;
    writeFileSync(path.join(directory, basename), 'x');
    sleepSynchronously(delayMilliseconds);
  }
  process.stdout.write(`${JSON.stringify({
    count,
    delayMilliseconds,
    milliseconds: Number((performance.now() - startedAt).toFixed(2)),
  })}\n`);
  return true;
}

function runExternalWriter(directory, prefix, count, delayMilliseconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--internal-distinct-writer', directory, prefix, String(count), String(delayMilliseconds)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`External writer failed: code=${code}, signal=${signal}, stderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`External writer returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function normalizeRelative(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForQuiet(eventCount, { quietMilliseconds = 350, maximumMilliseconds = 10_000 } = {}) {
  const startedAt = performance.now();
  let lastCount = eventCount();
  let lastChangeAt = performance.now();
  while (performance.now() - startedAt < maximumMilliseconds) {
    await sleep(50);
    const currentCount = eventCount();
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      lastChangeAt = performance.now();
    }
    if (performance.now() - lastChangeAt >= quietMilliseconds) break;
  }
  return {
    elapsedMilliseconds: Number((performance.now() - startedAt).toFixed(2)),
    finalEventCount: eventCount(),
  };
}

function createRecorder(specifications) {
  const events = [];
  const errors = [];
  const watchers = [];
  let sequence = 0;
  try {
    for (const specification of specifications) {
      const watcher = watch(
        specification.directory,
        { recursive: specification.recursive, encoding: 'utf8' },
        (eventType, filename) => {
          const rawFilename = filename === null || filename === undefined ? null : String(filename);
          const relativePath = rawFilename === null
            ? null
            : normalizeRelative(path.posix.join(specification.prefix, normalizeRelative(rawFilename)));
          events.push({
            sequence: sequence++,
            watcher: specification.name,
            eventType,
            filename: rawFilename,
            relativePath,
            milliseconds: Number(performance.now().toFixed(3)),
          });
        },
      );
      watcher.on('error', (error) => {
        errors.push({
          watcher: specification.name,
          code: error?.code || null,
          name: error?.name || null,
          message: error?.message || String(error),
        });
      });
      watchers.push(watcher);
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    return {
      available: false,
      setupError: {
        code: error?.code || null,
        name: error?.name || null,
        message: error?.message || String(error),
      },
      events,
      errors,
      close() {},
    };
  }
  return {
    available: true,
    setupError: null,
    events,
    errors,
    close() {
      for (const watcher of watchers) watcher.close();
    },
  };
}

function flatWatcherSpecifications(tree) {
  return [
    { name: 'mythpen', directory: tree.mythpen, prefix: '', recursive: false },
    { name: 'volumes', directory: tree.volumes, prefix: 'volumes', recursive: false },
    { name: 'chapters', directory: tree.chapters, prefix: 'chapters', recursive: false },
  ];
}

function recursiveWatcherSpecifications(tree) {
  return [{ name: 'mythpen-recursive', directory: tree.mythpen, prefix: '', recursive: true }];
}

function resetChapters(tree) {
  const resolvedRoot = path.resolve(tree.root);
  const resolvedChapters = path.resolve(tree.chapters);
  if (!resolvedChapters.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe probe cleanup target: ${resolvedChapters}`);
  }
  if (existsSync(resolvedChapters)) rmSync(resolvedChapters, { recursive: true, force: true });
  mkdirSync(resolvedChapters, { recursive: false });
}

function sampleEvents(events) {
  return events.slice(0, EVENT_SAMPLE_LIMIT);
}

async function measureRecursiveDelivery(tree) {
  resetChapters(tree);
  const recorder = createRecorder(recursiveWatcherSpecifications(tree));
  if (!recorder.available) {
    return { available: false, setupError: recorder.setupError, errors: recorder.errors };
  }
  try {
    await sleep(250);
    const directRelative = 'chapters/direct-probe.txt';
    const nestedRelative = 'chapters/deep-a/deep-b/nested-probe.txt';
    mkdirSync(path.join(tree.chapters, 'deep-a', 'deep-b'), { recursive: true });
    writeFileSync(path.join(tree.root, directRelative), 'direct\n');
    writeFileSync(path.join(tree.root, nestedRelative), 'nested\n');
    const quiet = await waitForQuiet(() => recorder.events.length);
    const observed = new Set(recorder.events.map((event) => event.relativePath).filter(Boolean));
    return {
      available: true,
      directRelative,
      nestedRelative,
      directObserved: observed.has(directRelative),
      nestedObserved: observed.has(nestedRelative),
      nullFilenameEvents: recorder.events.filter((event) => event.filename === null).length,
      errors: recorder.errors,
      quiet,
      eventCount: recorder.events.length,
      events: sampleEvents(recorder.events),
    };
  } finally {
    recorder.close();
  }
}

async function measureSameFileBurst(tree, writes) {
  resetChapters(tree);
  const targetRelative = 'chapters/ch_same_file_probe.md';
  const targetPath = path.join(tree.root, targetRelative);
  writeFileSync(targetPath, 'before\n');
  const recorder = createRecorder(flatWatcherSpecifications(tree));
  if (!recorder.available) {
    return { available: false, setupError: recorder.setupError, errors: recorder.errors };
  }
  try {
    await sleep(250);
    const startedAt = performance.now();
    for (let index = 0; index < writes; index += 1) {
      writeFileSync(targetPath, `revision-${index}\n`);
    }
    const writeMilliseconds = Number((performance.now() - startedAt).toFixed(2));
    const quiet = await waitForQuiet(() => recorder.events.length);
    const matching = recorder.events.filter((event) => event.relativePath === targetRelative);
    return {
      available: true,
      targetRelative,
      attemptedWrites: writes,
      writeMilliseconds,
      matchingEventCount: matching.length,
      detectionObserved: matching.length > 0,
      fewerEventsThanWrites: matching.length < writes,
      nullFilenameEvents: recorder.events.filter((event) => event.filename === null).length,
      errors: recorder.errors,
      quiet,
      events: sampleEvents(matching),
    };
  } finally {
    recorder.close();
  }
}

async function measureDistinctPathPressure(tree, count, mode) {
  resetChapters(tree);
  const specifications = mode === 'recursive'
    ? recursiveWatcherSpecifications(tree)
    : flatWatcherSpecifications(tree);
  const recorder = createRecorder(specifications);
  if (!recorder.available) {
    return { mode, available: false, setupError: recorder.setupError, errors: recorder.errors };
  }
  try {
    await sleep(250);
    const prefix = `overflow_${mode}_`;
    const startedAt = performance.now();
    writeDistinctFiles(tree.chapters, prefix, count);
    const writeMilliseconds = Number((performance.now() - startedAt).toFixed(2));
    const quiet = await waitForQuiet(
      () => recorder.events.length,
      { quietMilliseconds: 1_000, maximumMilliseconds: 30_000 },
    );
    const expectedPrefix = `chapters/${prefix}`;
    const observed = new Set(
      recorder.events
        .map((event) => event.relativePath)
        .filter((relativePath) => relativePath?.startsWith(expectedPrefix)),
    );
    const nullFilenameEvents = recorder.events.filter((event) => event.filename === null).length;
    const missingDistinctPaths = count - observed.size;
    return {
      mode,
      available: true,
      attemptedDistinctPaths: count,
      observedDistinctPaths: observed.size,
      missingDistinctPaths,
      writeMilliseconds,
      totalEventCount: recorder.events.length,
      nullFilenameEvents,
      errors: recorder.errors,
      explicitLossSignal: nullFilenameEvents > 0 || recorder.errors.length > 0,
      silentLossObserved: missingDistinctPaths > 0 && nullFilenameEvents === 0 && recorder.errors.length === 0,
      quiet,
      events: sampleEvents(recorder.events),
    };
  } finally {
    recorder.close();
  }
}

async function measureDistinctPathFlow(tree, count, mode, delayMilliseconds = 0) {
  resetChapters(tree);
  const specifications = mode === 'recursive'
    ? recursiveWatcherSpecifications(tree)
    : flatWatcherSpecifications(tree);
  const recorder = createRecorder(specifications);
  if (!recorder.available) {
    return { mode, available: false, setupError: recorder.setupError, errors: recorder.errors };
  }
  try {
    await sleep(250);
    const prefix = `external_${mode}_${delayMilliseconds}_`;
    const writer = await runExternalWriter(tree.chapters, prefix, count, delayMilliseconds);
    const quiet = await waitForQuiet(
      () => recorder.events.length,
      { quietMilliseconds: 1_000, maximumMilliseconds: 30_000 },
    );
    const expectedPrefix = `chapters/${prefix}`;
    const observed = new Set(
      recorder.events
        .map((event) => event.relativePath)
        .filter((relativePath) => relativePath?.startsWith(expectedPrefix)),
    );
    const nullFilenameEvents = recorder.events.filter((event) => event.filename === null).length;
    const missingDistinctPaths = count - observed.size;
    return {
      mode,
      available: true,
      producer: 'independent compiled child; watcher event loop remains live',
      attemptedDistinctPaths: count,
      delayMilliseconds,
      observedDistinctPaths: observed.size,
      missingDistinctPaths,
      writer,
      totalEventCount: recorder.events.length,
      nullFilenameEvents,
      errors: recorder.errors,
      explicitLossSignal: nullFilenameEvents > 0 || recorder.errors.length > 0,
      silentLossObserved: missingDistinctPaths > 0 && nullFilenameEvents === 0 && recorder.errors.length === 0,
      quiet,
      events: sampleEvents(recorder.events),
    };
  } finally {
    recorder.close();
  }
}

function durableCandidateWrite(candidatePath, content) {
  const descriptor = openSync(candidatePath, 'w');
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function measureAtomicReplace(tree, iterations) {
  resetChapters(tree);
  const targetRelative = 'chapters/ch_atomic_probe.md';
  const targetPath = path.join(tree.root, targetRelative);
  writeFileSync(targetPath, 'before\n');
  const recorder = createRecorder(flatWatcherSpecifications(tree));
  if (!recorder.available) {
    return { available: false, setupError: recorder.setupError, errors: recorder.errors };
  }
  const runs = [];
  try {
    await sleep(250);
    for (let index = 0; index < iterations; index += 1) {
      const candidateRelative = `chapters/.ch_atomic_probe.${String(index).padStart(4, '0')}.candidate`;
      const candidatePath = path.join(tree.root, candidateRelative);
      const mark = recorder.events.length;
      let operationError = null;
      try {
        durableCandidateWrite(candidatePath, `after-${index}\n`);
        renameSync(candidatePath, targetPath);
      } catch (error) {
        operationError = {
          code: error?.code || null,
          name: error?.name || null,
          message: error?.message || String(error),
        };
      }
      await waitForQuiet(() => recorder.events.length, { quietMilliseconds: 150, maximumMilliseconds: 5_000 });
      const matching = recorder.events.slice(mark).filter((event) => (
        event.relativePath === candidateRelative || event.relativePath === targetRelative
      ));
      runs.push({
        iteration: index,
        candidateRelative,
        operationError,
        targetObserved: matching.some((event) => event.relativePath === targetRelative),
        candidateObserved: matching.some((event) => event.relativePath === candidateRelative),
        sequence: matching.map((event) => `${event.eventType}:${event.relativePath}`),
        sequenceShape: matching.map((event) => (
          `${event.eventType}:${event.relativePath === candidateRelative ? '<candidate>' : '<target>'}`
        )),
      });
      if (operationError) break;
    }
    const distribution = new Map();
    for (const run of runs) {
      const key = run.sequenceShape.join(' -> ');
      distribution.set(key, (distribution.get(key) || 0) + 1);
    }
    return {
      available: true,
      targetRelative,
      attemptedIterations: iterations,
      completedIterations: runs.filter((run) => !run.operationError).length,
      targetObservedEveryCompletedIteration: runs
        .filter((run) => !run.operationError)
        .every((run) => run.targetObserved),
      candidateObservedEveryCompletedIteration: runs
        .filter((run) => !run.operationError)
        .every((run) => run.candidateObserved),
      errors: recorder.errors,
      nullFilenameEvents: recorder.events.filter((event) => event.filename === null).length,
      sequenceDistribution: [...distribution.entries()].map(([sequence, occurrences]) => ({ sequence, occurrences })),
      runs,
    };
  } finally {
    recorder.close();
  }
}

function runtimeIdentity() {
  return {
    platform: process.platform,
    architecture: process.arch,
    execPath: process.execPath,
    versions: process.versions,
    bunVersion: typeof Bun === 'undefined' ? null : Bun.version,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (runInternalWriter(argv)) return;
  const options = parseArguments(argv);
  const probeRoot = mkdtempSync(path.join(tmpdir(), `mythpen-l2-watch-${process.platform}-`));
  const tree = {
    root: path.join(probeRoot, 'mythpen'),
    mythpen: path.join(probeRoot, 'mythpen'),
    volumes: path.join(probeRoot, 'mythpen', 'volumes'),
    chapters: path.join(probeRoot, 'mythpen', 'chapters'),
  };
  mkdirSync(tree.volumes, { recursive: true });
  mkdirSync(tree.chapters, { recursive: true });
  const result = {
    probeVersion: PROBE_VERSION,
    capturedAt: new Date().toISOString(),
    runtime: runtimeIdentity(),
    options,
    probeRoot,
    recursiveDelivery: null,
    sameFileBurst: null,
    distinctPathFlow: {},
    distinctPathPaced: {},
    distinctPathPressure: {},
    atomicReplace: null,
  };
  try {
    result.recursiveDelivery = await measureRecursiveDelivery(tree);
    result.sameFileBurst = await measureSameFileBurst(tree, options.sameFileWrites);
    result.distinctPathFlow.recursive = await measureDistinctPathFlow(tree, options.externalCount, 'recursive');
    result.distinctPathFlow.flatThreeDirectories = await measureDistinctPathFlow(tree, options.externalCount, 'flat');
    result.distinctPathPaced.recursive = await measureDistinctPathFlow(
      tree,
      options.pacedCount,
      'recursive',
      options.pacedDelayMilliseconds,
    );
    result.distinctPathPaced.flatThreeDirectories = await measureDistinctPathFlow(
      tree,
      options.pacedCount,
      'flat',
      options.pacedDelayMilliseconds,
    );
    result.distinctPathPressure.recursive = await measureDistinctPathPressure(tree, options.overflowCount, 'recursive');
    result.distinctPathPressure.flatThreeDirectories = await measureDistinctPathPressure(tree, options.overflowCount, 'flat');
    result.atomicReplace = await measureAtomicReplace(tree, options.atomicIterations);
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) writeFileSync(options.output, serialized);
    process.stdout.write(serialized);
  } finally {
    if (!options.keep) {
      const resolvedRoot = path.resolve(probeRoot);
      const resolvedTemp = path.resolve(tmpdir());
      if (!resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`)) {
        throw new Error(`Unsafe probe root cleanup target: ${resolvedRoot}`);
      }
      rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
