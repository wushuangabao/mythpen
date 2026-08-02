import type { RevisionDecision } from '@/lib/api'

export type RevisionPart =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'revision'; id: string; before: string; after: string }

type DiffOperation = { kind: 'equal' | 'delete' | 'insert'; text: string } | { kind: 'boundary' }

const MAX_MATRIX_CELLS = 800_000
const MAX_COARSE_MATRIX_CELLS = 4_000_000
const MAX_REFINEMENT_CELLS = 200_000
const REVIEW_CHUNK_SIZE = 160
const TOKEN_PATTERN = /\r\n|[\n\r]|[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z\u00c0-\u024f0-9_]+|\s+|[^\s]/gu
const REVIEW_BOUNDARY_PATTERN = /[。！？!?；;：:]$/

function tokenize(content: string): string[] {
  return content.match(TOKEN_PATTERN) || []
}

function exceedsReviewChunkSize(tokens: string[]): boolean {
  let codePointCount = 0
  for (const token of tokens) {
    for (const _codePoint of token) {
      codePointCount++
      if (codePointCount > REVIEW_CHUNK_SIZE) return true
    }
  }
  return false
}

function appendOperation(operations: DiffOperation[], kind: 'equal' | 'delete' | 'insert', text: string) {
  if (!text) return
  const previous = operations[operations.length - 1]
  if (previous?.kind === kind) {
    previous.text += text
  } else {
    operations.push({ kind, text })
  }
}

function appendBoundary(operations: DiffOperation[]) {
  if (operations.length > 0 && operations[operations.length - 1]?.kind !== 'boundary') {
    operations.push({ kind: 'boundary' })
  }
}

function appendOperations(target: DiffOperation[], source: DiffOperation[]) {
  for (const operation of source) {
    if (operation.kind === 'boundary') appendBoundary(target)
    else appendOperation(target, operation.kind, operation.text)
  }
}

function diffWithMatrix(before: string[], after: string[]): DiffOperation[] {
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex--) {
    const row = beforeIndex * width
    const nextRow = (beforeIndex + 1) * width
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex--) {
      table[row + afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? table[nextRow + afterIndex + 1] + 1
          : Math.max(table[nextRow + afterIndex], table[row + afterIndex + 1])
    }
  }

  const operations: DiffOperation[] = []
  let beforeIndex = 0
  let afterIndex = 0
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      appendOperation(operations, 'equal', before[beforeIndex])
      beforeIndex++
      afterIndex++
    } else if (table[(beforeIndex + 1) * width + afterIndex] >= table[beforeIndex * width + afterIndex + 1]) {
      appendOperation(operations, 'delete', before[beforeIndex])
      beforeIndex++
    } else {
      appendOperation(operations, 'insert', after[afterIndex])
      afterIndex++
    }
  }
  while (beforeIndex < before.length) appendOperation(operations, 'delete', before[beforeIndex++])
  while (afterIndex < after.length) appendOperation(operations, 'insert', after[afterIndex++])
  return operations
}

/**
 * Preserve sentence and paragraph boundaries when the character-level LCS would
 * exceed its memory budget. A fixed cap also handles unusually long sentences.
 */
function createReviewChunks(tokens: string[]): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let currentCodePointCount = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push(current.join(''))
    current = []
    currentCodePointCount = 0
  }

  for (const token of tokens) {
    // Iterate strings by code point, not UTF-16 code unit. This keeps surrogate
    // pairs intact at review boundaries and also caps a single huge word/ID.
    for (const codePoint of token) {
      current.push(codePoint)
      currentCodePointCount++
      if (currentCodePointCount >= REVIEW_CHUNK_SIZE) flush()
    }
    const naturalBoundary = token === '\r\n' || token === '\n' || token === '\r' || REVIEW_BOUNDARY_PATTERN.test(token)
    if (naturalBoundary) flush()
  }
  flush()
  return chunks
}

function appendChunkedReplacement(before: string[], after: string[], operations: DiffOperation[]) {
  const beforeChunks = createReviewChunks(before)
  const afterChunks = createReviewChunks(after)
  const chunkCount = Math.max(beforeChunks.length, afterChunks.length)

  for (let index = 0; index < chunkCount; index++) {
    const beforeStart = Math.floor((index * beforeChunks.length) / chunkCount)
    const beforeEnd = Math.floor(((index + 1) * beforeChunks.length) / chunkCount)
    const afterStart = Math.floor((index * afterChunks.length) / chunkCount)
    const afterEnd = Math.floor(((index + 1) * afterChunks.length) / chunkCount)
    const beforeText = beforeChunks.slice(beforeStart, beforeEnd).join('')
    const afterText = afterChunks.slice(afterStart, afterEnd).join('')
    if (!beforeText && !afterText) continue

    if (beforeText === afterText) {
      appendOperation(operations, 'equal', beforeText)
    } else {
      const beforeTokens = tokenize(beforeText)
      const afterTokens = tokenize(afterText)
      if ((beforeTokens.length + 1) * (afterTokens.length + 1) <= MAX_REFINEMENT_CELLS) {
        appendOperations(operations, diffWithMatrix(beforeTokens, afterTokens))
      } else {
        appendOperation(operations, 'delete', beforeText)
        appendOperation(operations, 'insert', afterText)
      }
    }

    // Adjacent replacement blocks deliberately remain separate review choices,
    // even when a heavily rewritten chapter has no exact text between them.
    if (index < chunkCount - 1) appendBoundary(operations)
  }
}

function appendReplacement(before: string[], after: string[], operations: DiffOperation[]) {
  if (before.length === 0) {
    if (!exceedsReviewChunkSize(after)) appendOperation(operations, 'insert', after.join(''))
    else appendChunkedReplacement(before, after, operations)
    return
  }
  if (after.length === 0) {
    if (!exceedsReviewChunkSize(before)) appendOperation(operations, 'delete', before.join(''))
    else appendChunkedReplacement(before, after, operations)
    return
  }

  const cells = (before.length + 1) * (after.length + 1)
  if (cells <= MAX_REFINEMENT_CELLS) {
    appendOperations(operations, splitLongReplacementOperations(diffWithMatrix(before, after)))
    return
  }

  appendChunkedReplacement(before, after, operations)
}

function splitLongReplacementOperations(operations: DiffOperation[]): DiffOperation[] {
  const chunkedOperations: DiffOperation[] = []
  let pendingBefore = ''
  let pendingAfter = ''

  const flushReplacement = () => {
    if (!pendingBefore && !pendingAfter) return
    const before = tokenize(pendingBefore)
    const after = tokenize(pendingAfter)
    if (exceedsReviewChunkSize(before) || exceedsReviewChunkSize(after)) {
      appendChunkedReplacement(before, after, chunkedOperations)
    } else {
      appendOperation(chunkedOperations, 'delete', pendingBefore)
      appendOperation(chunkedOperations, 'insert', pendingAfter)
    }
    pendingBefore = ''
    pendingAfter = ''
  }

  for (const operation of operations) {
    if (operation.kind === 'equal') {
      flushReplacement()
      appendOperation(chunkedOperations, 'equal', operation.text)
    } else if (operation.kind === 'delete') {
      pendingBefore += operation.text
    } else if (operation.kind === 'insert') {
      pendingAfter += operation.text
    } else {
      flushReplacement()
      appendBoundary(chunkedOperations)
    }
  }
  flushReplacement()
  return chunkedOperations
}

function fallbackDiff(before: string[], after: string[]): DiffOperation[] {
  let prefixLength = 0
  while (prefixLength < before.length && prefixLength < after.length && before[prefixLength] === after[prefixLength]) {
    prefixLength++
  }

  let suffixLength = 0
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) {
    suffixLength++
  }

  const operations: DiffOperation[] = []
  appendOperation(operations, 'equal', before.slice(0, prefixLength).join(''))

  const beforeMiddle = before.slice(prefixLength, before.length - suffixLength)
  const afterMiddle = after.slice(prefixLength, after.length - suffixLength)
  const coarseBefore = createReviewChunks(beforeMiddle)
  const coarseAfter = createReviewChunks(afterMiddle)

  if (coarseBefore.length === 0 || coarseAfter.length === 0) {
    appendReplacement(beforeMiddle, afterMiddle, operations)
  } else if ((coarseBefore.length + 1) * (coarseAfter.length + 1) > MAX_COARSE_MATRIX_CELLS) {
    appendChunkedReplacement(beforeMiddle, afterMiddle, operations)
  } else {
    const coarseOperations = diffWithMatrix(coarseBefore, coarseAfter)
    let pendingBefore = ''
    let pendingAfter = ''

    const flushReplacement = () => {
      if (!pendingBefore && !pendingAfter) return
      appendReplacement(tokenize(pendingBefore), tokenize(pendingAfter), operations)
      pendingBefore = ''
      pendingAfter = ''
    }

    for (const operation of coarseOperations) {
      if (operation.kind === 'equal') {
        flushReplacement()
        appendOperation(operations, 'equal', operation.text)
      } else if (operation.kind === 'delete') {
        pendingBefore += operation.text
      } else if (operation.kind === 'insert') {
        pendingAfter += operation.text
      }
    }
    flushReplacement()
  }

  appendOperation(operations, 'equal', before.slice(before.length - suffixLength).join(''))
  return operations
}

function diffTokens(before: string[], after: string[]): DiffOperation[] {
  if (before.length === 0 && after.length === 0) return []
  if (before.length === 0) {
    return splitLongReplacementOperations([{ kind: 'insert', text: after.join('') }])
  }
  if (after.length === 0) {
    return splitLongReplacementOperations([{ kind: 'delete', text: before.join('') }])
  }

  const cells = (before.length + 1) * (after.length + 1)
  if (cells > MAX_MATRIX_CELLS) return fallbackDiff(before, after)
  return splitLongReplacementOperations(diffWithMatrix(before, after))
}

export function buildRevisionParts(before: string, after: string): RevisionPart[] {
  const operations = diffTokens(tokenize(before), tokenize(after))
  const parts: RevisionPart[] = []
  let textIndex = 0
  let revisionIndex = 0
  let pendingBefore = ''
  let pendingAfter = ''

  const flushRevision = () => {
    if (!pendingBefore && !pendingAfter) return
    parts.push({ kind: 'revision', id: `change-${revisionIndex++}`, before: pendingBefore, after: pendingAfter })
    pendingBefore = ''
    pendingAfter = ''
  }

  for (const operation of operations) {
    if (operation.kind === 'boundary') {
      flushRevision()
      continue
    }
    if (operation.kind === 'equal') {
      flushRevision()
      const previous = parts[parts.length - 1]
      if (previous?.kind === 'text') previous.text += operation.text
      else parts.push({ kind: 'text', id: `text-${textIndex++}`, text: operation.text })
    } else if (operation.kind === 'delete') {
      pendingBefore += operation.text
    } else {
      pendingAfter += operation.text
    }
  }
  flushRevision()
  return parts
}

export function countPendingRevisions(parts: RevisionPart[], decisions: Record<string, RevisionDecision>): number {
  return parts.reduce((count, part) => {
    if (part.kind !== 'revision' || decisions[part.id]) return count
    return count + 1
  }, 0)
}

export function materializeRevision(parts: RevisionPart[], decisions: Record<string, RevisionDecision>): string {
  return parts
    .map((part) => {
      if (part.kind === 'text') return part.text
      return decisions[part.id] === 'accepted' ? part.after : part.before
    })
    .join('')
}
