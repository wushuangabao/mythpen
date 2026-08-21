'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { serializeCanonicalJson } = require('../../manuscript/format');

const MAX_WORKING_BUFFER_BYTES = 64 * 1024;
const PROJECT_UID = '90000000-0000-4000-8000-000000000001';
const BODY_PATTERN = Buffer.from('Mythpen deterministic benchmark text. ', 'utf8');

const FIXED_L2_BENCHMARK_PROFILES = Object.freeze({
  'chapters-3000': Object.freeze({
    chapterCount: 3_000,
    fixtureId: 'chapters-3000',
    formalProfile: true,
    targetControlledBytes: 34 * 1024 * 1024,
    volumeCount: 300,
  }),
  'chapters-10000-1gib': Object.freeze({
    chapterCount: 10_000,
    fixtureId: 'chapters-10000-1gib',
    formalProfile: true,
    targetControlledBytes: 1024 ** 3,
    volumeCount: 2_000,
  }),
});

const PROBE_PROFILE = Object.freeze({
  chapterCount: 4,
  fixtureId: 'streaming-probe',
  formalProfile: false,
  targetControlledBytes: 1024 * 1024,
  volumeCount: 2,
});

const L2_PERFORMANCE_CASE_IDS = Object.freeze([
  'sidebar_3000',
  'autosave_3000',
  'startup_full_3000',
  'explicit_full_3000',
  'sidebar_10000',
  'autosave_10000',
  'startup_full_10000',
  'explicit_full_10000',
]);

function canonicalUid(prefix, index) {
  assert.ok(Number.isSafeInteger(index) && index >= 1 && index <= 0xffff_ffff_ffff);
  return `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function volumeUid(index) {
  return canonicalUid('91000000', index);
}

function chapterUid(index) {
  return canonicalUid('92000000', index);
}

function chaptersForVolume(volumeIndex, profile) {
  const first = Math.ceil(((volumeIndex - 1) * profile.chapterCount) / profile.volumeCount) + 1;
  const last = Math.ceil((volumeIndex * profile.chapterCount) / profile.volumeCount);
  const values = [];
  for (let index = first; index <= last; index += 1) values.push(chapterUid(index));
  return values;
}

function sidecarValue(index) {
  return {
    format_version: 1,
    chapter_uid: chapterUid(index),
    title: `Benchmark chapter ${index}`,
    outline: '',
    status: 'pending',
    summary: '',
    cognitive_frame: '',
    emotional_anchor: '',
    world_texture: '',
    concrete_mystery: '',
    interpersonal_tension: '',
  };
}

function volumeValue(index, profile) {
  return {
    format_version: 1,
    volume_uid: volumeUid(index),
    title: `Benchmark volume ${index}`,
    summary: '',
    chapter_uids: chaptersForVolume(index, profile),
  };
}

function * manuscriptSegments(profile) {
  yield Buffer.from(`{\n  "format_version": 1,\n  "project_uid": "${PROJECT_UID}",\n  "volume_uids": [`, 'utf8');
  for (let index = 1; index <= profile.volumeCount; index += 1) {
    const prefix = index === 1 ? '\n' : ',\n';
    yield Buffer.from(`${prefix}    "${volumeUid(index)}"`, 'utf8');
  }
  yield Buffer.from('\n  ]\n}\n', 'utf8');
}

function byteLengthOfSegments(segments) {
  let total = 0;
  for (const segment of segments) total += segment.length;
  return total;
}

function jsonPlan(profile) {
  let jsonBytes = byteLengthOfSegments(manuscriptSegments(profile));
  jsonBytes += serializeCanonicalJson('unassigned', {
    format_version: 1,
    kind: 'unassigned',
    chapter_uids: [],
  }).length;
  for (let index = 1; index <= profile.volumeCount; index += 1) {
    jsonBytes += serializeCanonicalJson('volume_index', volumeValue(index, profile)).length;
  }
  for (let index = 1; index <= profile.chapterCount; index += 1) {
    jsonBytes += serializeCanonicalJson('chapter_sidecar', sidecarValue(index)).length;
  }
  const bodyBytes = profile.targetControlledBytes - jsonBytes;
  if (bodyBytes < profile.chapterCount) throw new TypeError('benchmark profile body budget is invalid');
  const bodyBaseBytes = Math.floor(bodyBytes / profile.chapterCount);
  const bodyExtraCount = bodyBytes % profile.chapterCount;
  if (bodyBaseBytes + 1 > 16 * 1024 * 1024) {
    throw new TypeError('benchmark profile exceeds the single markdown limit');
  }
  return { bodyBaseBytes, bodyExtraCount, jsonBytes };
}

function planDescription(profile) {
  const plan = jsonPlan(profile);
  const material = JSON.stringify({
    version: 1,
    fixtureId: profile.fixtureId,
    projectUid: PROJECT_UID,
    chapterCount: profile.chapterCount,
    volumeCount: profile.volumeCount,
    targetControlledBytes: profile.targetControlledBytes,
    controlledFileCount: 2 + profile.volumeCount + (2 * profile.chapterCount),
    chapterDirectoryEntries: 2 * profile.chapterCount,
    bodyBaseBytes: plan.bodyBaseBytes,
    bodyExtraCount: plan.bodyExtraCount,
    jsonBytes: plan.jsonBytes,
    maxWorkingBufferBytes: MAX_WORKING_BUFFER_BYTES,
  });
  return Object.freeze({
    version: 1,
    profile: profile.fixtureId,
    formalProfile: profile.formalProfile,
    projectUid: PROJECT_UID,
    chapterCount: profile.chapterCount,
    volumeCount: profile.volumeCount,
    targetControlledBytes: profile.targetControlledBytes,
    controlledFileCount: 2 + profile.volumeCount + (2 * profile.chapterCount),
    chapterDirectoryEntries: 2 * profile.chapterCount,
    bodyBaseBytes: plan.bodyBaseBytes,
    bodyExtraCount: plan.bodyExtraCount,
    jsonBytes: plan.jsonBytes,
    maxWorkingBufferBytes: MAX_WORKING_BUFFER_BYTES,
    planSha256: createHash('sha256').update(material).digest('hex'),
  });
}

function describeL2BenchmarkProfile(profileName) {
  if (!Object.hasOwn(FIXED_L2_BENCHMARK_PROFILES, profileName)) {
    throw new TypeError('profileName must be a fixed L2 benchmark profile');
  }
  return planDescription(FIXED_L2_BENCHMARK_PROFILES[profileName]);
}

function assertCreateNewProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || fs.existsSync(projectRoot)) {
    throw new TypeError('projectRoot must be an absolute create-new path');
  }
  const parent = path.dirname(projectRoot);
  const parentMetadata = fs.lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new TypeError('projectRoot parent must be an ordinary directory');
  }
}

function updateManifest(manifest, relativePath, bytes, sha256) {
  manifest.update(relativePath.replaceAll(path.sep, '/'));
  manifest.update('\0');
  manifest.update(String(bytes));
  manifest.update('\0');
  manifest.update(sha256);
  manifest.update('\n');
}

function writeAllSync(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(file, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('benchmark fixture write made no progress');
    }
    offset += written;
  }
}

function createNewFileFromSegments(filePath, segments, observation) {
  const file = fs.openSync(filePath, 'wx');
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for (const segment of segments) {
      if (!Buffer.isBuffer(segment) || segment.length > MAX_WORKING_BUFFER_BYTES) {
        throw new TypeError('fixture segment exceeds the fixed buffer budget');
      }
      observation.maxObservedBufferBytes = Math.max(observation.maxObservedBufferBytes, segment.length);
      writeAllSync(file, segment);
      digest.update(segment);
      bytes += segment.length;
    }
  } finally {
    fs.closeSync(file);
  }
  return { bytes, sha256: digest.digest('hex') };
}

function repeatedBodyChunk() {
  const chunk = Buffer.allocUnsafe(MAX_WORKING_BUFFER_BYTES);
  for (let offset = 0; offset < chunk.length; offset += BODY_PATTERN.length) {
    BODY_PATTERN.copy(chunk, offset, 0, Math.min(BODY_PATTERN.length, chunk.length - offset));
  }
  return chunk;
}

function createRepeatedBody(filePath, byteLength, chunk, observation) {
  const file = fs.openSync(filePath, 'wx');
  const digest = createHash('sha256');
  let remaining = byteLength;
  try {
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      const segment = length === chunk.length ? chunk : chunk.subarray(0, length);
      observation.maxObservedBufferBytes = Math.max(observation.maxObservedBufferBytes, segment.length);
      writeAllSync(file, segment);
      digest.update(segment);
      remaining -= length;
    }
  } finally {
    fs.closeSync(file);
  }
  return { bytes: byteLength, sha256: digest.digest('hex') };
}

function materializeProfile({ projectRoot, profile }) {
  assertCreateNewProjectRoot(projectRoot);
  const description = planDescription(profile);
  const mythpenRoot = path.join(projectRoot, 'mythpen');
  const volumesRoot = path.join(mythpenRoot, 'volumes');
  const chaptersRoot = path.join(mythpenRoot, 'chapters');
  fs.mkdirSync(volumesRoot, { recursive: true });
  fs.mkdirSync(chaptersRoot);

  const manifest = createHash('sha256');
  const observation = { maxObservedBufferBytes: 0 };
  let controlledBytes = 0;
  let controlledFiles = 0;
  const record = (relativePath, identity) => {
    controlledBytes += identity.bytes;
    controlledFiles += 1;
    updateManifest(manifest, relativePath, identity.bytes, identity.sha256);
  };

  const manuscriptPath = path.join(mythpenRoot, 'manuscript.json');
  record(
    path.relative(projectRoot, manuscriptPath),
    createNewFileFromSegments(manuscriptPath, manuscriptSegments(profile), observation),
  );
  const unassignedPath = path.join(mythpenRoot, 'unassigned.json');
  record(
    path.relative(projectRoot, unassignedPath),
    createNewFileFromSegments(unassignedPath, [serializeCanonicalJson('unassigned', {
      format_version: 1,
      kind: 'unassigned',
      chapter_uids: [],
    })], observation),
  );

  for (let index = 1; index <= profile.volumeCount; index += 1) {
    const target = path.join(volumesRoot, `vol_${volumeUid(index)}.json`);
    record(
      path.relative(projectRoot, target),
      createNewFileFromSegments(
        target,
        [serializeCanonicalJson('volume_index', volumeValue(index, profile))],
        observation,
      ),
    );
  }

  const bodyChunk = repeatedBodyChunk();
  observation.maxObservedBufferBytes = Math.max(observation.maxObservedBufferBytes, bodyChunk.length);
  for (let index = 1; index <= profile.chapterCount; index += 1) {
    const uid = chapterUid(index);
    const bodyBytes = description.bodyBaseBytes + (index <= description.bodyExtraCount ? 1 : 0);
    const bodyPath = path.join(chaptersRoot, `ch_${uid}.md`);
    record(
      path.relative(projectRoot, bodyPath),
      createRepeatedBody(bodyPath, bodyBytes, bodyChunk, observation),
    );
    const sidecarPath = path.join(chaptersRoot, `ch_${uid}.json`);
    record(
      path.relative(projectRoot, sidecarPath),
      createNewFileFromSegments(
        sidecarPath,
        [serializeCanonicalJson('chapter_sidecar', sidecarValue(index))],
        observation,
      ),
    );
  }

  assert.equal(controlledFiles, description.controlledFileCount);
  assert.equal(controlledBytes, description.targetControlledBytes);
  return Object.freeze({
    ...description,
    actualControlledBytes: controlledBytes,
    manifestSha256: manifest.digest('hex'),
    maxObservedBufferBytes: observation.maxObservedBufferBytes,
  });
}

function materializeL2BenchmarkProject({ projectRoot, profile }) {
  if (!Object.hasOwn(FIXED_L2_BENCHMARK_PROFILES, profile)) {
    throw new TypeError('profile must be a fixed L2 benchmark profile');
  }
  return materializeProfile({ projectRoot, profile: FIXED_L2_BENCHMARK_PROFILES[profile] });
}

function materializeL2BenchmarkProbe({ projectRoot }) {
  return materializeProfile({ projectRoot, profile: PROBE_PROFILE });
}

function hashFileStreaming(filePath, scratch) {
  const file = fs.openSync(filePath, 'r');
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for (;;) {
      const count = fs.readSync(file, scratch, 0, scratch.length, null);
      if (count === 0) break;
      digest.update(scratch.subarray(0, count));
      bytes += count;
    }
  } finally {
    fs.closeSync(file);
  }
  return { bytes, sha256: digest.digest('hex') };
}

function countDirectoryEntries(directory) {
  const handle = fs.opendirSync(directory);
  let count = 0;
  try {
    while (handle.readSync() !== null) count += 1;
  } finally {
    handle.closeSync();
  }
  return count;
}

function profileFromExpected(expected) {
  if (expected?.formalProfile === false && expected?.profile === PROBE_PROFILE.fixtureId) {
    return PROBE_PROFILE;
  }
  if (expected && Object.hasOwn(FIXED_L2_BENCHMARK_PROFILES, expected.profile)) {
    return FIXED_L2_BENCHMARK_PROFILES[expected.profile];
  }
  throw new TypeError('expected must come from the fixed fixture generator');
}

function verifyL2BenchmarkProject({ projectRoot, expected }) {
  const profile = profileFromExpected(expected);
  const description = planDescription(profile);
  for (const key of Object.keys(description)) assert.equal(expected[key], description[key]);
  const mythpenRoot = path.join(projectRoot, 'mythpen');
  const volumesRoot = path.join(mythpenRoot, 'volumes');
  const chaptersRoot = path.join(mythpenRoot, 'chapters');
  assert.equal(countDirectoryEntries(mythpenRoot), 4);
  assert.equal(countDirectoryEntries(volumesRoot), profile.volumeCount);
  assert.equal(countDirectoryEntries(chaptersRoot), profile.chapterCount * 2);

  const scratch = Buffer.allocUnsafe(MAX_WORKING_BUFFER_BYTES);
  const manifest = createHash('sha256');
  let controlledBytes = 0;
  let controlledFiles = 0;
  const verify = (target) => {
    const metadata = fs.lstatSync(target);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    const identity = hashFileStreaming(target, scratch);
    controlledBytes += identity.bytes;
    controlledFiles += 1;
    updateManifest(manifest, path.relative(projectRoot, target), identity.bytes, identity.sha256);
  };

  verify(path.join(mythpenRoot, 'manuscript.json'));
  verify(path.join(mythpenRoot, 'unassigned.json'));
  for (let index = 1; index <= profile.volumeCount; index += 1) {
    verify(path.join(volumesRoot, `vol_${volumeUid(index)}.json`));
  }
  for (let index = 1; index <= profile.chapterCount; index += 1) {
    const uid = chapterUid(index);
    verify(path.join(chaptersRoot, `ch_${uid}.md`));
    verify(path.join(chaptersRoot, `ch_${uid}.json`));
  }

  assert.equal(controlledFiles, description.controlledFileCount);
  assert.equal(controlledBytes, description.targetControlledBytes);
  const result = Object.freeze({
    ...description,
    actualControlledBytes: controlledBytes,
    manifestSha256: manifest.digest('hex'),
    maxObservedBufferBytes: MAX_WORKING_BUFFER_BYTES,
  });
  assert.equal(result.manifestSha256, expected.manifestSha256);
  assert.ok(expected.maxObservedBufferBytes <= MAX_WORKING_BUFFER_BYTES);
  return result;
}

module.exports = {
  FIXED_L2_BENCHMARK_PROFILES,
  L2_PERFORMANCE_CASE_IDS,
  describeL2BenchmarkProfile,
  materializeL2BenchmarkProbe,
  materializeL2BenchmarkProject,
  verifyL2BenchmarkProject,
};
