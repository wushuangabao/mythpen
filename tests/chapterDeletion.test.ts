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
const { useChapterStore } = await vite.ssrLoadModule('/src/stores/useChapterStore.ts')
const { useProjectStore } = await vite.ssrLoadModule('/src/stores/useProjectStore.ts')
const { PROJECT_INSTANCE_HEADER, forgetProjectInstance, rememberProjectInstance } = await vite.ssrLoadModule(
  '/src/lib/projectInstanceRegistry.ts',
)
const { discardEditorSave, discardProjectEditorSaves, enqueueEditorSave, flushEditorSave, getEditorSaveDraft } =
  await vite.ssrLoadModule('/src/lib/editorSaveQueue.ts')
const { discardProjectTitleSaves, getTitleSaveDraft, stageTitleSave } = await vite.ssrLoadModule(
  '/src/lib/titleSaveQueue.ts',
)

after(async () => {
  await vite.close()
})

function chapter(id: number, num: number) {
  return {
    id,
    volumeId: 1,
    num,
    dataVersion: 1,
    title: `第${num}章`,
    outline: '',
    content: `正文 ${num}`,
    wordCount: 4,
    status: 'pending',
  }
}

function apiChapter(chapterData: ReturnType<typeof chapter>) {
  return {
    id: chapterData.id,
    volume_id: chapterData.volumeId,
    num: chapterData.num,
    data_version: chapterData.dataVersion,
    title: chapterData.title,
    outline: chapterData.outline,
    content: chapterData.content,
    word_count: chapterData.wordCount,
    status: chapterData.status,
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function activateProject(project: string, instanceId: string) {
  useProjectStore.setState({
    currentProject: project,
    projects: [
      {
        id: project,
        name: project,
        iconName: 'BookOpen',
        genres: [],
        wordCount: 0,
        chapterCount: 0,
        lastOpened: '',
        status: '刚起步',
        instanceId,
      },
    ],
  })
}

function clearProject(project: string) {
  forgetProjectInstance(project)
  useProjectStore.setState({ currentProject: null, projects: [] })
}

async function deleteCurrentChapter(target: ReturnType<typeof chapter>) {
  const project = `chapter-delete-${target.id}`
  const capturedInstanceId = `captured-instance-${target.id}`
  const first = chapter(11, 1)
  const second = chapter(22, 2)
  const third = chapter(33, 3)
  const chapters = [first, second, third]
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; instanceId: string | null }> = []

  activateProject(project, capturedInstanceId)
  // The registry can change between opening a confirmation dialog and DELETE.
  // The request must still use the token captured by that dialog.
  rememberProjectInstance(project, `mutable-registry-instance-${target.id}`)
  useChapterStore.setState({
    projectName: project,
    currentChapter: target,
    volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters }],
    loading: false,
    saveStatus: 'saved',
  })
  enqueueEditorSave(project, target.id, target.num, `未保存正文 ${target.num}`, target.dataVersion)
  stageTitleSave(project, target.id, target.num, `未保存标题 ${target.num}`)

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const method = init?.method || 'GET'
    requests.push({ url, method, instanceId: new Headers(init?.headers).get(PROJECT_INSTANCE_HEADER) })
    if (method === 'DELETE') return json({ success: true, chapter_id: target.id, volume_id: 1, deleted_num: target.num })
    if (url.endsWith(`/${project}/volumes`)) {
      return json([
        {
          id: 1,
          sort_order: 1,
          title: '第一卷',
          chapters: chapters.filter((candidate) => candidate.id !== target.id).map(apiChapter),
        },
      ])
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch

  try {
    await useChapterStore.getState().deleteChapter(project, target, capturedInstanceId)
    return {
      currentChapter: useChapterStore.getState().currentChapter,
      editorDraft: getEditorSaveDraft(project, target.id),
      requests,
      titleDraft: getTitleSaveDraft(project, target.id),
    }
  } finally {
    globalThis.fetch = originalFetch
    discardProjectEditorSaves(project)
    discardProjectTitleSaves(project)
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
}

test('deleting the current chapter targets its stable identity and selects the next chapter', async () => {
  const target = chapter(22, 2)

  const { currentChapter, editorDraft, requests, titleDraft } = await deleteCurrentChapter(target)

  assert.deepEqual(requests, [
    {
      method: 'DELETE',
      url: '/api/chapter-delete-22/chapters/2?chapter_id=22&volume_id=1',
      instanceId: 'captured-instance-22',
    },
    { method: 'GET', url: '/api/chapter-delete-22/volumes', instanceId: 'mutable-registry-instance-22' },
  ])
  assert.equal(currentChapter?.id, 33)
  assert.equal(editorDraft, null)
  assert.equal(titleDraft, null)
})

test('deleting the last current chapter selects the previous chapter', async () => {
  const target = chapter(33, 3)

  const { currentChapter } = await deleteCurrentChapter(target)

  assert.equal(currentChapter?.id, 22)
})

test('deleting a non-current chapter returns its latest adjacent chapter id', async () => {
  const project = 'chapter-delete-local-outline-selection'
  const instanceId = 'chapter-delete-local-outline-selection-instance'
  const first = chapter(11, 1)
  const target = chapter(22, 2)
  const third = chapter(33, 3)
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error

  activateProject(project, instanceId)
  useChapterStore.setState({
    projectName: project,
    currentChapter: first,
    volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [first, target, third] }],
    loading: false,
    saveStatus: 'saved',
  })
  globalThis.fetch = (async (input, init) => {
    if ((init?.method || 'GET') === 'DELETE') return json({ success: true })
    if (String(input).endsWith(`/${project}/volumes`)) return json({ error: { message: 'refresh failed' } }, 503)
    throw new Error(`unexpected request: ${String(input)}`)
  }) as typeof fetch
  console.error = () => {}

  try {
    const fallbackChapterId = await useChapterStore.getState().deleteChapter(project, target, instanceId)

    assert.equal(fallbackChapterId, third.id)
    assert.equal(useChapterStore.getState().currentChapter?.id, first.id)
    assert.deepEqual(
      useChapterStore.getState().volumes.flatMap((volume) => volume.chapters.map((candidate) => candidate.id)),
      [first.id, third.id],
    )
  } finally {
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})

test('chapter deletion rejects missing captured instance tokens without fetching', async () => {
  const project = 'chapter-delete-missing-instance'
  const loadedInstanceId = 'chapter-delete-missing-instance-loaded'
  const target = chapter(44, 4)
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  let fetches = 0

  activateProject(project, loadedInstanceId)
  useChapterStore.setState({
    projectName: project,
    currentChapter: target,
    volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [target] }],
    loading: false,
    saveStatus: 'saved',
  })
  globalThis.fetch = (async () => {
    fetches++
    throw new Error('DELETE must not fetch without a captured instance token')
  }) as typeof fetch
  console.error = () => {}

  try {
    await assert.rejects(useChapterStore.getState().deleteChapter(project, target, ''), /实例|instance/i)
    await assert.rejects(useChapterStore.getState().deleteChapter(project, target, '   '), /实例|instance/i)
    assert.equal(fetches, 0)
    assert.equal(useChapterStore.getState().currentChapter?.id, target.id)
  } finally {
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})

test('chapter deletion rejects a captured token that no longer matches the active instance', async () => {
  const project = 'chapter-delete-stale-instance'
  const activeInstanceId = 'chapter-delete-stale-instance-active'
  const target = chapter(45, 5)
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  let fetches = 0

  activateProject(project, activeInstanceId)
  useChapterStore.setState({
    projectName: project,
    currentChapter: target,
    volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [target] }],
    loading: false,
    saveStatus: 'saved',
  })
  globalThis.fetch = (async () => {
    fetches++
    throw new Error('DELETE must not fetch for a stale captured instance token')
  }) as typeof fetch
  console.error = () => {}

  try {
    await assert.rejects(
      useChapterStore.getState().deleteChapter(project, target, 'chapter-delete-stale-instance-old'),
      /实例|instance/i,
    )
    assert.equal(fetches, 0)
    assert.equal(useChapterStore.getState().currentChapter?.id, target.id)
  } finally {
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})

test('a successful delete survives a failed chapter-list refresh', async () => {
  const project = 'chapter-delete-refresh-failure'
  const instanceId = 'chapter-delete-refresh-failure-instance'
  const first = chapter(11, 1)
  const target = chapter(22, 2)
  const third = chapter(33, 3)
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error

  activateProject(project, instanceId)
  useChapterStore.setState({
    projectName: project,
    currentChapter: target,
    volumes: [{ id: 1, sortOrder: 1, title: 'Volume', chapters: [first, target, third] }],
    loading: false,
    saveStatus: 'unsaved',
  })
  enqueueEditorSave(project, target.id, target.num, 'draft content', target.dataVersion)
  stageTitleSave(project, target.id, target.num, 'draft title')
  globalThis.fetch = (async (input, init) => {
    if ((init?.method || 'GET') === 'DELETE') return json({ success: true })
    if (String(input).endsWith('/' + project + '/volumes')) return json({ error: { message: 'refresh failed' } }, 503)
    throw new Error('unexpected request: ' + String(input))
  }) as typeof fetch
  console.error = () => {}

  try {
    await assert.doesNotReject(useChapterStore.getState().deleteChapter(project, target, instanceId))
    assert.equal(useChapterStore.getState().currentChapter?.id, third.id)
    assert.deepEqual(
      useChapterStore.getState().volumes.flatMap((volume) => volume.chapters.map((candidate) => candidate.id)),
      [first.id, third.id],
    )
    assert.equal(getEditorSaveDraft(project, target.id), null)
    assert.equal(getTitleSaveDraft(project, target.id), null)
  } finally {
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    discardProjectEditorSaves(project)
    discardProjectTitleSaves(project)
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})

test('a delete uses the latest chapter structure when its DELETE settles', async () => {
  const project = 'chapter-delete-latest-fallback'
  const instanceId = 'chapter-delete-latest-fallback-instance'
  const first = chapter(11, 1)
  const target = chapter(22, 2)
  const staleNext = chapter(33, 3)
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  let resolveDelete!: (response: Response) => void
  let markDeleteStarted!: () => void
  const deleteResponse = new Promise<Response>((resolve) => {
    resolveDelete = resolve
  })
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve
  })

  activateProject(project, instanceId)
  useChapterStore.setState({
    projectName: project,
    currentChapter: target,
    volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [first, target, staleNext] }],
    loading: false,
    saveStatus: 'saved',
  })
  globalThis.fetch = (async (input, init) => {
    if ((init?.method || 'GET') === 'DELETE') {
      markDeleteStarted()
      return deleteResponse
    }
    if (String(input).endsWith(`/${project}/volumes`)) return json({ error: { message: 'refresh failed' } }, 503)
    throw new Error(`unexpected request: ${String(input)}`)
  }) as typeof fetch
  console.error = () => {}

  try {
    const deletion = useChapterStore.getState().deleteChapter(project, target, instanceId)
    await deleteStarted

    // A concurrent structure refresh removed the chapter that was the old
    // snapshot's fallback. Only the first chapter remains after this delete.
    useChapterStore.setState({
      projectName: project,
      currentChapter: target,
      volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [first, target] }],
    })

    resolveDelete(json({ success: true }))
    const fallbackChapterId = await deletion

    assert.equal(fallbackChapterId, first.id)
    assert.equal(useChapterStore.getState().currentChapter?.id, first.id)
    assert.deepEqual(
      useChapterStore.getState().volumes.flatMap((volume) => volume.chapters.map((candidate) => candidate.id)),
      [first.id],
    )
  } finally {
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})

test('a delete returns no fallback or selection update when the latest structure already removed its target', async () => {
  const project = 'chapter-delete-target-already-removed'
  const instanceId = 'chapter-delete-target-already-removed-instance'
  const first = chapter(11, 1)
  const target = chapter(22, 2)
  const third = chapter(33, 3)
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  let resolveDelete!: (response: Response) => void
  let markDeleteStarted!: () => void
  const deleteResponse = new Promise<Response>((resolve) => {
    resolveDelete = resolve
  })
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve
  })

  activateProject(project, instanceId)
  useChapterStore.setState({
    projectName: project,
    currentChapter: first,
    volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [first, target, third] }],
    loading: false,
    saveStatus: 'saved',
  })
  globalThis.fetch = (async (input, init) => {
    if ((init?.method || 'GET') === 'DELETE') {
      markDeleteStarted()
      return deleteResponse
    }
    if (String(input).endsWith(`/${project}/volumes`)) return json({ error: { message: 'refresh failed' } }, 503)
    throw new Error(`unexpected request: ${String(input)}`)
  }) as typeof fetch
  console.error = () => {}

  try {
    const deletion = useChapterStore.getState().deleteChapter(project, target, instanceId)
    await deleteStarted

    // A newer structure commit has already removed this target and selected a
    // different chapter. The completed DELETE must not overwrite that choice.
    useChapterStore.setState({
      projectName: project,
      currentChapter: third,
      volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [first, third] }],
    })

    resolveDelete(json({ success: true }))
    const fallbackChapterId = await deletion

    assert.equal(fallbackChapterId, undefined)
    assert.equal(useChapterStore.getState().currentChapter?.id, third.id)
    assert.deepEqual(
      useChapterStore.getState().volumes.flatMap((volume) => volume.chapters.map((candidate) => candidate.id)),
      [first.id, third.id],
    )
  } finally {
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})

test('a delete that succeeds after navigation clears old drafts without touching the new project', async () => {
  const deletedProject = 'chapter-delete-navigated-away'
  const deletedInstanceId = 'chapter-delete-navigated-away-instance'
  const activeProject = 'chapter-delete-active-project'
  const target = chapter(66, 6)
  const activeChapter = chapter(77, 7)
  const originalFetch = globalThis.fetch
  let resolveDelete!: (response: Response) => void
  const deleteResponse = new Promise<Response>((resolve) => {
    resolveDelete = resolve
  })

  activateProject(deletedProject, deletedInstanceId)
  useChapterStore.setState({
    projectName: deletedProject,
    currentChapter: target,
    volumes: [{ id: 1, sortOrder: 1, title: 'Deleted project', chapters: [target] }],
    loading: false,
    saveStatus: 'unsaved',
  })
  enqueueEditorSave(deletedProject, target.id, target.num, 'old project draft', target.dataVersion)
  stageTitleSave(deletedProject, target.id, target.num, 'old project title draft')
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method || 'GET') === 'DELETE') return deleteResponse
    throw new Error('unexpected request')
  }) as typeof fetch

  try {
    const deletion = useChapterStore.getState().deleteChapter(deletedProject, target, deletedInstanceId)
    useProjectStore.setState((state) => ({
      projects: [
        ...state.projects,
        {
          id: activeProject,
          name: activeProject,
          iconName: 'BookOpen',
          genres: [],
          wordCount: 0,
          chapterCount: 1,
          lastOpened: '',
          status: '刚起步',
          instanceId: 'chapter-delete-active-project-instance',
          openState: 'ready',
        },
      ],
    }))
    useProjectStore.getState().setCurrentProject(activeProject)
    useChapterStore.setState({
      projectName: activeProject,
      currentChapter: activeChapter,
      volumes: [{ id: 2, sortOrder: 1, title: 'Active project', chapters: [activeChapter] }],
      loading: false,
      saveStatus: 'saved',
    })

    resolveDelete(json({ success: true }))
    await deletion

    assert.equal(getEditorSaveDraft(deletedProject, target.id), null)
    assert.equal(getTitleSaveDraft(deletedProject, target.id), null)
    assert.equal(useProjectStore.getState().currentProject, activeProject)
    assert.equal(useChapterStore.getState().projectName, activeProject)
    assert.equal(useChapterStore.getState().currentChapter?.id, activeChapter.id)
    assert.deepEqual(
      useChapterStore.getState().volumes.flatMap((volume) => volume.chapters.map((candidate) => candidate.id)),
      [activeChapter.id],
    )
  } finally {
    globalThis.fetch = originalFetch
    discardProjectEditorSaves(deletedProject)
    discardProjectEditorSaves(activeProject)
    discardProjectTitleSaves(deletedProject)
    discardProjectTitleSaves(activeProject)
    clearProject(deletedProject)
    forgetProjectInstance(activeProject)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})

test('discarding a deleted chapter draft prevents a queued editor write from running', async () => {
  const project = 'chapter-delete-discarded-draft'
  const chapterId = 44
  let writes = 0

  enqueueEditorSave(project, chapterId, 4, '不应写回已删除章节的正文', 1)
  const pendingWrite = flushEditorSave(project, chapterId, async () => {
    writes++
    return 2
  })
  discardEditorSave(project, chapterId)

  try {
    await pendingWrite
    assert.equal(writes, 0)
    assert.equal(getEditorSaveDraft(project, chapterId), null)
  } finally {
    discardProjectEditorSaves(project)
  }
})

test('a failed chapter deletion keeps the current chapter and unsaved drafts recoverable', async () => {
  const project = 'chapter-delete-failure'
  const instanceId = 'chapter-delete-failure-instance'
  const target = chapter(55, 5)
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error

  activateProject(project, instanceId)
  useChapterStore.setState({
    projectName: project,
    currentChapter: target,
    volumes: [{ id: 1, sortOrder: 1, title: '第一卷', chapters: [target] }],
    loading: false,
    saveStatus: 'unsaved',
  })
  enqueueEditorSave(project, target.id, target.num, '仍应保留的正文草稿', target.dataVersion)
  stageTitleSave(project, target.id, target.num, '仍应保留的标题草稿')
  globalThis.fetch = (async () => json({ error: { message: '删除服务暂时不可用' } }, 503)) as typeof fetch
  console.error = () => {}

  try {
    await assert.rejects(useChapterStore.getState().deleteChapter(project, target, instanceId), /删除服务暂时不可用/)
    assert.equal(useChapterStore.getState().currentChapter?.id, target.id)
    assert.equal(getEditorSaveDraft(project, target.id)?.content, '仍应保留的正文草稿')
    assert.equal(getTitleSaveDraft(project, target.id)?.title, '仍应保留的标题草稿')
  } finally {
    console.error = originalConsoleError
    globalThis.fetch = originalFetch
    discardProjectEditorSaves(project)
    discardProjectTitleSaves(project)
    clearProject(project)
    useChapterStore.setState({ projectName: null, currentChapter: null, volumes: [], loading: false, saveStatus: 'saved' })
  }
})
