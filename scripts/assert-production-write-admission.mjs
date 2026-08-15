import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function maskCommentsAndStrings(source) {
  const masked = [...source]
  let state = 'code'
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (current === '/' && next === '/') {
        masked[index] = masked[index + 1] = ' '
        index += 1
        state = 'line-comment'
      } else if (current === '/' && next === '*') {
        masked[index] = masked[index + 1] = ' '
        index += 1
        state = 'block-comment'
      } else if (current === "'" || current === '"' || current === '`') {
        masked[index] = ' '
        state = current === "'" ? 'single' : current === '"' ? 'double' : 'template'
      }
      continue
    }

    if (current === '\n' && state === 'line-comment') {
      state = 'code'
      continue
    }
    masked[index] = current === '\n' ? '\n' : ' '
    if (state === 'block-comment' && current === '*' && next === '/') {
      masked[index + 1] = ' '
      index += 1
      state = 'code'
      continue
    }
    if (['single', 'double', 'template'].includes(state)) {
      if (current === '\\') {
        if (index + 1 < source.length) masked[index + 1] = source[index + 1] === '\n' ? '\n' : ' '
        index += 1
      } else if (
        (state === 'single' && current === "'") ||
        (state === 'double' && current === '"') ||
        (state === 'template' && current === '`')
      ) {
        state = 'code'
      }
    }
  }
  return masked.join('')
}

function productionServerFiles(repositoryRoot) {
  const serverRoot = join(repositoryRoot, 'server')
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const rel = relative(repositoryRoot, absolute).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        if (rel === 'server/tests' || rel.startsWith('server/tests/') || rel === 'server/testing') continue
        visit(absolute)
      } else if (entry.isFile() && entry.name.endsWith('.js') && rel !== 'server/project-write-coordinator.js') {
        files.push({ absolute, file: rel })
      }
    }
  }
  visit(serverRoot)
  return files.sort((left, right) => left.file.localeCompare(right.file))
}

function matches(source, expression, file) {
  const rows = []
  for (const match of source.matchAll(expression)) {
    rows.push({
      file,
      line: source.slice(0, match.index).split('\n').length,
      name: match[1],
    })
  }
  return rows
}

export function scanProductionWriteAdmissions(repositoryRoot) {
  const asyncAdmissions = []
  const syncAdmissions = []
  for (const entry of productionServerFiles(resolve(repositoryRoot))) {
    const masked = maskCommentsAndStrings(readFileSync(entry.absolute, 'utf8'))
    asyncAdmissions.push(...matches(masked, /\b(withProjectWrite)\s*\(/g, entry.file))
    syncAdmissions.push(...matches(masked, /\b(withProject(?:WriteSync|RecoveryLeaseSync))\s*\(/g, entry.file))
  }
  return { asyncAdmissions, syncAdmissions }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  const repositoryRoot = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const report = scanProductionWriteAdmissions(repositoryRoot)
  process.stdout.write(`MYTHPEN_PRODUCTION_WRITE_ADMISSION ${JSON.stringify(report)}\n`)
  if (report.asyncAdmissions.length > 0) process.exitCode = 1
}
