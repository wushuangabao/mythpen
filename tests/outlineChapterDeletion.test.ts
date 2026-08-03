import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
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
const { getChapterDeletionFallbackId } = await vite.ssrLoadModule('/src/lib/chapterDeletionFallback.ts')
const { getLanguage, setLanguage } = await vite.ssrLoadModule('/src/i18n/index.ts')
const { Outline } = await vite.ssrLoadModule('/src/pages/Outline.tsx')
const { useChapterStore } = await vite.ssrLoadModule('/src/stores/useChapterStore.ts')
const { useProjectStore } = await vite.ssrLoadModule('/src/stores/useProjectStore.ts')

after(async () => {
  await vite.close()
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor)
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage
  }
})

test('chooses the next outline chapter after deletion', () => {
  assert.equal(
    getChapterDeletionFallbackId([{ id: 11 }, { id: 22 }, { id: 33 }], 22),
    33,
  )
})

test('chooses the previous outline chapter when the deleted chapter is last', () => {
  assert.equal(
    getChapterDeletionFallbackId([{ id: 11 }, { id: 22 }, { id: 33 }], 33),
    22,
  )
})

test('returns null when deleting the only outline chapter or an unknown chapter', () => {
  assert.equal(getChapterDeletionFallbackId([{ id: 11 }], 11), null)
  assert.equal(getChapterDeletionFallbackId([{ id: 11 }, { id: 22 }], 99), null)
})

test('renders a delete control for the initially selected outline chapter', () => {
  const project = 'outline-delete-render'
  const previousLanguage = getLanguage()
  const previousProjectState = useProjectStore.getState()
  const previousChapterState = useChapterStore.getState()
  const projectInitialState = useProjectStore.getInitialState()
  const chapterInitialState = useChapterStore.getInitialState()
  const previousProjectInitialState = { ...projectInitialState }
  const previousChapterInitialState = { ...chapterInitialState }
  const projectFixture = {
    currentProject: project,
    projects: [{ name: project, instanceId: 'outline-instance' }] as never,
  }
  const chapterFixture = {
    projectName: project,
    currentChapter: null,
    volumes: [
      {
        id: 1,
        sortOrder: 1,
        title: '\u7b2c\u4e00\u5377',
        chapters: [
          {
            id: 11,
            volumeId: 1,
            num: 1,
            dataVersion: 1,
            title: '\u5f00\u7ae0',
            outline: '',
            content: '',
            wordCount: 0,
            status: 'pending',
          },
        ],
      },
    ],
  } as never
  try {
    useProjectStore.setState(projectFixture)
    useChapterStore.setState(chapterFixture)
    Object.assign(projectInitialState, projectFixture)
    Object.assign(chapterInitialState, chapterFixture)
    setLanguage('zh')
    const markup = renderToStaticMarkup(createElement(Outline))
    assert.match(markup, /\u5220\u9664\u7ae0\u8282/)
    assert.match(markup, /flex min-h-0 min-w-0 flex-1 flex-col/)
    assert.doesNotMatch(markup, /\u6c38\u4e45\u5220\u9664\u9879\u76ee/)
  } finally {
    useProjectStore.setState(previousProjectState, true)
    useChapterStore.setState(previousChapterState, true)
    Object.assign(projectInitialState, previousProjectInitialState)
    Object.assign(chapterInitialState, previousChapterInitialState)
    setLanguage(previousLanguage)
    storage.clear()
  }
})

test('cleans the server-rendered fixture storage', () => {
  assert.equal(storage.size, 0)
})

test('renders a programmatically focusable empty outline state', () => {
  const project = 'outline-delete-empty'
  const previousLanguage = getLanguage()
  const previousProjectState = useProjectStore.getState()
  const previousChapterState = useChapterStore.getState()
  const projectInitialState = useProjectStore.getInitialState()
  const chapterInitialState = useChapterStore.getInitialState()
  const previousProjectInitialState = { ...projectInitialState }
  const previousChapterInitialState = { ...chapterInitialState }
  const projectFixture = {
    currentProject: project,
    projects: [{ name: project, instanceId: 'outline-empty-instance' }] as never,
  }
  const chapterFixture = {
    projectName: project,
    currentChapter: null,
    volumes: [],
  } as never
  try {
    useProjectStore.setState(projectFixture)
    useChapterStore.setState(chapterFixture)
    Object.assign(projectInitialState, projectFixture)
    Object.assign(chapterInitialState, chapterFixture)
    setLanguage('zh')
    const markup = renderToStaticMarkup(createElement(Outline))
    assert.match(markup, /\u6682\u65e0\u7ae0\u8282/)
    assert.match(markup, /tabindex="-1"/)
  } finally {
    useProjectStore.setState(previousProjectState, true)
    useChapterStore.setState(previousChapterState, true)
    Object.assign(projectInitialState, previousProjectInitialState)
    Object.assign(chapterInitialState, previousChapterInitialState)
    setLanguage(previousLanguage)
    storage.clear()
  }
})
