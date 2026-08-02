import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
})

const vite = await createServer({ appType: 'custom', server: { middlewareMode: true } })
const { useRevisionStore } = await vite.ssrLoadModule('/src/stores/useRevisionStore.ts')
const { useChapterStore } = await vite.ssrLoadModule('/src/stores/useChapterStore.ts')
const { useProjectStore } = await vite.ssrLoadModule('/src/stores/useProjectStore.ts')
const { forgetProjectInstance, rememberProjectInstance } = await vite.ssrLoadModule(
  '/src/lib/projectInstanceRegistry.ts',
)
const { hasPendingRevisionMutation, retireProjectRevisionMutations } = await vite.ssrLoadModule(
  '/src/lib/revisionMutationReconciliation.ts',
)

after(async () => {
  await vite.close()
})

function revision(chapterId: number) {
  return {
    id: 41,
    chapterId,
    baseContent: '旧正文',
    proposedContent: '新正文',
    decisions: {},
    status: 'pending',
    previousChapterStatus: 'writing',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    resolvedAt: null,
  }
}

function activateChapter(project: string, content = '旧正文') {
  const chapter = {
    id: 7,
    volumeId: 3,
    num: 1,
    dataVersion: 1,
    title: '第一章',
    outline: '',
    content,
    wordCount: content.length,
    status: 'review',
  }
  useProjectStore.setState({ currentProject: project })
  useChapterStore.setState({
    projectName: project,
    currentChapter: chapter,
    volumes: [{ id: 3, sortOrder: 1, title: '第一卷', chapters: [chapter] }],
    loading: false,
    saveStatus: 'saved',
  })
  useRevisionStore.setState({
    revision: revision(chapter.id),
    revisionProject: project,
    loading: false,
    saving: false,
    error: null,
    editorLocks: [],
  })
  return chapter
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('active revision is kept until the authoritative chapter reload completes', async () => {
  const originalFetch = globalThis.fetch
  const project = 'revision-disappeared-before-ack'
  const chapter = activateChapter(project)
  let releaseChapter!: () => void
  const chapterMayReturn = new Promise<void>((resolve) => {
    releaseChapter = resolve
  })
  let chapterRequested!: () => void
  const sawChapterRequest = new Promise<void>((resolve) => {
    chapterRequested = resolve
  })

  globalThis.fetch = (async (input) => {
    const url = String(input)
    if (url.includes('/revisions/active')) return json({ revision: null, rebased: false })
    if (url.includes(`/${project}/chapters/${chapter.num}`)) {
      chapterRequested()
      await chapterMayReturn
      return json({
        id: chapter.id,
        volume_id: chapter.volumeId,
        num: chapter.num,
        data_version: 2,
        title: chapter.title,
        content: '服务端已提交正文',
        word_count: 8,
        status: 'accepted',
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    const loading = useRevisionStore.getState().loadRevision(project, chapter.id)
    await sawChapterRequest
    assert.equal(useRevisionStore.getState().revision?.id, 41)

    releaseChapter()
    await loading
    assert.equal(useRevisionStore.getState().revision, null)
    assert.equal(useChapterStore.getState().currentChapter?.content, '服务端已提交正文')
  } finally {
    releaseChapter()
    globalThis.fetch = originalFetch
  }
})

test('a window that never saw the revision reloads a newer resolved chapter before reopening the editor', async () => {
  const originalFetch = globalThis.fetch
  const project = 'revision-resolved-before-first-observation'
  const originalChapter = activateChapter(project)
  const staleChapter = { ...originalChapter, status: 'writing' }
  useChapterStore.setState({
    currentChapter: staleChapter,
    volumes: [{ id: 3, sortOrder: 1, title: '第一卷', chapters: [staleChapter] }],
  })
  useRevisionStore.setState({
    revision: null,
    revisionProject: null,
    loading: false,
    saving: false,
    error: null,
    editorLocks: [],
  })
  let chapterLoads = 0

  globalThis.fetch = (async (input) => {
    const url = String(input)
    if (url.includes('/revisions/active')) {
      return json({ revision: null, rebased: false, chapterDataVersion: 3 })
    }
    if (url.includes(`/${project}/chapters/${staleChapter.num}`)) {
      chapterLoads++
      return json({
        id: staleChapter.id,
        volume_id: staleChapter.volumeId,
        num: staleChapter.num,
        data_version: 3,
        title: staleChapter.title,
        content: '另一窗口已接受的正文',
        word_count: 10,
        status: 'accepted',
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    await useRevisionStore.getState().loadRevision(project, staleChapter.id)
    assert.equal(chapterLoads, 1)
    assert.equal(useRevisionStore.getState().revision, null)
    assert.equal(useRevisionStore.getState().loading, false)
    assert.equal(useRevisionStore.getState().error, null)
    assert.equal(useChapterStore.getState().currentChapter?.content, '另一窗口已接受的正文')
    assert.equal(useChapterStore.getState().currentChapter?.dataVersion, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('failed authoritative reload keeps the known revision locked and retryable', async () => {
  const originalFetch = globalThis.fetch
  const project = 'revision-reload-failed'
  const chapter = activateChapter(project)

  globalThis.fetch = (async (input) => {
    const url = String(input)
    if (url.includes('/revisions/active')) return json({ revision: null, rebased: false })
    if (url.includes(`/${project}/chapters/${chapter.num}`)) return json({ error: 'offline' }, 503)
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    await useRevisionStore.getState().loadRevision(project, chapter.id)
    assert.equal(useRevisionStore.getState().revision?.id, 41)
    assert.match(useRevisionStore.getState().error || '', /无法刷新权威章节内容/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('accept-all ACK loss reconciles the committed chapter before clearing review state', async () => {
  const originalFetch = globalThis.fetch
  const project = 'revision-accept-ack-lost'
  const chapter = activateChapter(project)

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/accept-all')) {
      throw new Error('response ended before completion')
    }
    if (url.includes('/revisions/active')) return json({ revision: null, rebased: false })
    if (url.includes(`/${project}/chapters/${chapter.num}`)) {
      return json({
        id: chapter.id,
        volume_id: chapter.volumeId,
        num: chapter.num,
        data_version: 2,
        title: chapter.title,
        content: '接受后的权威正文',
        word_count: 8,
        status: 'accepted',
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    await useRevisionStore.getState().acceptAll(project, 41)
    assert.equal(useRevisionStore.getState().revision, null)
    assert.equal(useRevisionStore.getState().error, null)
    assert.equal(useChapterStore.getState().currentChapter?.content, '接受后的权威正文')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('accept-all response received on another chapter remains pending until returning chapter reloads authority', async () => {
  const originalFetch = globalThis.fetch
  const project = 'revision-accept-switch-ack-return'
  const chapter = activateChapter(project)
  const otherChapter = { ...chapter, id: 8, num: 2, title: '第二章', content: '第二章正文', wordCount: 5 }
  let releaseAccept!: (response: Response) => void
  const acceptResponse = new Promise<Response>((resolve) => {
    releaseAccept = resolve
  })
  let acceptStarted!: () => void
  const sawAccept = new Promise<void>((resolve) => {
    acceptStarted = resolve
  })
  let releaseReload!: () => void
  const reloadMayReturn = new Promise<void>((resolve) => {
    releaseReload = resolve
  })
  let reloadStarted!: () => void
  const sawReload = new Promise<void>((resolve) => {
    reloadStarted = resolve
  })

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/accept-all')) {
      acceptStarted()
      return acceptResponse
    }
    if (url.includes('/revisions/active')) return json({ revision: null, rebased: false })
    if (url.includes(`/${project}/chapters/${chapter.num}`)) {
      reloadStarted()
      await reloadMayReturn
      return json({
        id: chapter.id,
        volume_id: chapter.volumeId,
        num: chapter.num,
        data_version: 3,
        title: chapter.title,
        content: '切回后读取的权威正文',
        word_count: 10,
        status: 'accepted',
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    const accepting = useRevisionStore.getState().acceptAll(project, 41)
    await sawAccept
    useChapterStore.setState({
      currentChapter: otherChapter,
      volumes: [{ id: 3, sortOrder: 1, title: '第一卷', chapters: [chapter, otherChapter] }],
    })
    useRevisionStore.getState().clearRevision()

    releaseAccept(
      json({
        success: true,
        chapterId: chapter.id,
        content: 'ACK 中的权威正文',
        wordCount: 9,
        status: 'accepted',
        dataVersion: 2,
      }),
    )
    await accepting
    assert.equal(useChapterStore.getState().currentChapter?.id, otherChapter.id)
    assert.equal(useChapterStore.getState().currentChapter?.content, otherChapter.content)
    assert.equal(hasPendingRevisionMutation(project, undefined, chapter.id), true)

    useChapterStore.setState({ currentChapter: chapter })
    const loading = useRevisionStore.getState().loadRevision(project, chapter.id)
    await sawReload
    assert.equal(useRevisionStore.getState().loading, true)
    assert.equal(useRevisionStore.getState().revision, null)

    releaseReload()
    await loading
    assert.equal(useChapterStore.getState().currentChapter?.content, '切回后读取的权威正文')
    assert.equal(useRevisionStore.getState().loading, false)
    assert.equal(hasPendingRevisionMutation(project, undefined, chapter.id), false)
  } finally {
    releaseReload()
    globalThis.fetch = originalFetch
  }
})

test('returning before an ACK-loss callback stays locked until the in-flight marker settles and reloads again', async () => {
  const originalFetch = globalThis.fetch
  const project = 'revision-return-before-ack-loss'
  const chapter = activateChapter(project)
  const otherChapter = { ...chapter, id: 8, num: 2, title: '第二章', content: '第二章正文', wordCount: 5 }
  let rejectAccept!: (error: Error) => void
  const acceptResponse = new Promise<Response>((_resolve, reject) => {
    rejectAccept = reject
  })
  let acceptStarted!: () => void
  const sawAccept = new Promise<void>((resolve) => {
    acceptStarted = resolve
  })
  let chapterReloads = 0

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/accept-all')) {
      acceptStarted()
      return acceptResponse
    }
    if (url.includes('/revisions/active')) return json({ revision: null, rebased: false })
    if (url.includes(`/${project}/chapters/${chapter.num}`)) {
      chapterReloads++
      return json({
        id: chapter.id,
        volume_id: chapter.volumeId,
        num: chapter.num,
        data_version: 3,
        title: chapter.title,
        content: 'ACK 丢失后的权威正文',
        word_count: 10,
        status: 'accepted',
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    const accepting = useRevisionStore.getState().acceptAll(project, 41)
    await sawAccept
    useChapterStore.setState({
      currentChapter: otherChapter,
      volumes: [{ id: 3, sortOrder: 1, title: '第一卷', chapters: [chapter, otherChapter] }],
    })
    useRevisionStore.getState().clearRevision()

    useChapterStore.setState({ currentChapter: chapter })
    await useRevisionStore.getState().loadRevision(project, chapter.id)
    assert.equal(useRevisionStore.getState().loading, true)
    assert.equal(hasPendingRevisionMutation(project, undefined, chapter.id), true)

    rejectAccept(new Error('response ended before completion'))
    await accepting
    assert.ok(chapterReloads >= 2)
    assert.equal(useRevisionStore.getState().loading, false)
    assert.equal(useRevisionStore.getState().revision, null)
    assert.equal(useChapterStore.getState().currentChapter?.content, 'ACK 丢失后的权威正文')
    assert.equal(hasPendingRevisionMutation(project, undefined, chapter.id), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a response from a retired project instance cannot write into its same-name replacement', async () => {
  const originalFetch = globalThis.fetch
  const project = 'revision-old-instance-response'
  const chapter = activateChapter(project)
  rememberProjectInstance(project, 'old-instance')
  let releaseAccept!: (response: Response) => void
  const acceptResponse = new Promise<Response>((resolve) => {
    releaseAccept = resolve
  })
  let acceptStarted!: () => void
  const sawAccept = new Promise<void>((resolve) => {
    acceptStarted = resolve
  })

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/accept-all')) {
      acceptStarted()
      return acceptResponse
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  try {
    const accepting = useRevisionStore.getState().acceptAll(project, 41)
    await sawAccept

    rememberProjectInstance(project, 'new-instance')
    retireProjectRevisionMutations(project, 'old-instance')
    const replacementChapter = { ...chapter, content: '同名新实例正文', wordCount: 7 }
    useChapterStore.setState({
      currentChapter: replacementChapter,
      volumes: [{ id: 3, sortOrder: 1, title: '第一卷', chapters: [replacementChapter] }],
    })
    useRevisionStore.getState().clearRevision()

    releaseAccept(
      json({
        success: true,
        chapterId: chapter.id,
        content: '旧实例迟到正文',
        wordCount: 7,
        status: 'accepted',
        dataVersion: 99,
      }),
    )
    await accepting
    assert.equal(useChapterStore.getState().currentChapter?.content, '同名新实例正文')
    assert.equal(hasPendingRevisionMutation(project, 'old-instance', chapter.id), false)
  } finally {
    forgetProjectInstance(project, 'new-instance')
    retireProjectRevisionMutations(project)
    globalThis.fetch = originalFetch
  }
})
