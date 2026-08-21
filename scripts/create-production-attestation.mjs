#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WINDOWS_L2_PRODUCTION_ATTESTATION_TYPE,
  publishCanonicalJsonNoReplace,
  validateL2ProductionAttestation,
} from './production-evidence-publisher.js'

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc'
const COMMON_FLAGS = Object.freeze([
  '--profile',
  '--source-commit',
  '--l1-manifest',
  '--l2-manifest',
  '--build-receipt',
  '--candidate',
  '--results',
  '--output',
])

function exactAbsolutePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !path.isAbsolute(value)
    || path.resolve(value) !== value
  ) throw new Error(`${label} must be one normalized absolute path`)
  return value
}

function parseFlags(args, expectedFlags) {
  if (!Array.isArray(args) || args.length !== expectedFlags.length * 2) {
    throw new Error('Invalid production attestation arguments')
  }
  const allowed = new Set(expectedFlags)
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!allowed.has(flag) || Object.hasOwn(values, flag) || typeof value !== 'string' || value.length === 0) {
      throw new Error('Invalid production attestation arguments')
    }
    values[flag] = value
  }
  if (Object.keys(values).length !== allowed.size) {
    throw new Error('Invalid production attestation arguments')
  }
  return values
}

export function parseProductionAttestationArguments(args) {
  const profileIndex = args.indexOf('--profile')
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : ''
  if (profile !== 'l2-correctness') {
    throw new Error('Invalid production attestation arguments')
  }
  const values = parseFlags(args, COMMON_FLAGS)
  return {
    profile,
    sourceCommit: values['--source-commit'],
    l1ManifestPath: values['--l1-manifest'],
    l2ManifestPath: values['--l2-manifest'],
    buildReceiptPath: values['--build-receipt'],
    candidatePath: values['--candidate'],
    resultsPath: values['--results'],
    outputPath: values['--output'],
  }
}

function hashFile(filePath) {
  const hash = createHash('sha256')
  const handle = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

function artifactReference(filePath, withBytes = false) {
  const absolute = exactAbsolutePath(filePath, 'Attestation artifact path')
  const stats = fs.lstatSync(absolute)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Attestation artifact is not a plain file: ${absolute}`)
  }
  return Object.freeze({
    path: absolute,
    sha256: hashFile(absolute),
    ...(withBytes ? { bytes: stats.size } : {}),
  })
}

function assertRuntime(overrides = {}) {
  const runtime = overrides.runtime ?? {
    platform: process.platform,
    bunVersion: process.versions.bun,
  }
  if (runtime.platform !== 'win32' || runtime.bunVersion !== '1.3.14') {
    throw new Error('Production attestation requires Bun 1.3.14 on Windows')
  }
}

export function createProductionAttestation(options, overrides = {}) {
  assertRuntime(overrides)
  if (!COMMIT_PATTERN.test(options?.sourceCommit || '')) {
    throw new Error('Production attestation source commit is invalid')
  }
  if (options?.profile !== 'l2-correctness') {
    throw new Error('Production attestation profile is invalid')
  }
  const outputPath = exactAbsolutePath(options.outputPath, 'Attestation output')
  if (fs.existsSync(outputPath)) throw new Error('Production attestation output already exists')
  const resultsPath = exactAbsolutePath(options.resultsPath, 'Attestation results directory')
  const resultFiles = {
    l1NativeBenchmark: path.join(resultsPath, 'l1-native-benchmark.json'),
    l2ProductionE2e: path.join(resultsPath, 'l2-e2e.json'),
    desktopManuscriptFiles: path.join(resultsPath, 'desktop-manuscript-files.json'),
  }
  const readJson = overrides.readJson ?? ((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')))
  const buildReceiptPath = exactAbsolutePath(options.buildReceiptPath, 'Build receipt')
  const buildReceipt = readJson(buildReceiptPath)
  if (buildReceipt?.sourceCommit !== options.sourceCommit || buildReceipt?.targetTriple !== TARGET_TRIPLE) {
    throw new Error('Build receipt does not bind the requested source and target')
  }
  const value = Object.freeze({
    version: 1,
    type: WINDOWS_L2_PRODUCTION_ATTESTATION_TYPE,
    profile: options.profile,
    status: 'PASS',
    sourceCommit: options.sourceCommit,
    targetTriple: TARGET_TRIPLE,
    l1Manifest: artifactReference(options.l1ManifestPath),
    l2Manifest: artifactReference(options.l2ManifestPath),
    buildReceipt: artifactReference(buildReceiptPath),
    candidate: artifactReference(options.candidatePath, true),
    results: Object.freeze({
      l1NativeBenchmark: artifactReference(resultFiles.l1NativeBenchmark),
      l2ProductionE2e: artifactReference(resultFiles.l2ProductionE2e),
      desktopManuscriptFiles: artifactReference(resultFiles.desktopManuscriptFiles),
    }),
  })
  const validateAttestation = overrides.validateAttestation ?? validateL2ProductionAttestation
  validateAttestation(value)
  const publish = overrides.publish ?? ((request) => publishCanonicalJsonNoReplace(request))
  publish({ outputPath, value })
  return value
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    createProductionAttestation(parseProductionAttestationArguments(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`Production attestation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
