# World Entry Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete, safe world-entry editing and deletion to the UI while keeping REST and AI tool calls on one normalized data contract.

**Architecture:** A small server-side tag module normalizes every mutation boundary. The frontend converts API tag strings to arrays, reuses `SimpleCreateDialog` for editing, and reuses the timeline confirmation pattern for deletion. AI function schemas and tool execution consume the same normalized tag arrays.

**Tech Stack:** React 19, TypeScript, Express 5, sql.js, Node native `node:test`, Biome.

## Global Constraints

- Preserve existing user-owned untracked skill directories.
- Keep `world_entries.tags` as `TEXT`; do not add a database migration.
- Do not add a browser-test dependency solely for this feature.
- REST and AI mutations must accept legacy comma-separated tag strings as well as string arrays.

---

### Task 1: Normalize tags and prove the server/AI contract

**Files:**
- Create: `server/world-tags.js`
- Create: `server/tests/world-api.test.js`
- Create: `server/tests/world-tools.test.js`
- Modify: `server/routes/api.js:1-10,903-918`
- Modify: `server/tools.js:176-202,430-444,957-965,1120-1124`

**Interfaces:**
- Produces `parseWorldTags(value): string[]` and `serializeWorldTags(value): string` from `server/world-tags.js`.
- REST accepts `tags: string | string[]`; AI tool definitions advertise `tags: string[]`.

- [ ] **Step 1: Write failing API and AI-tool tests**

```js
assert.deepEqual(listed.body[0].tags, '["priority","city"]');
assert.deepEqual(executeTool(project, 'list_world', {})[0].tags, ['priority', 'city']);
assert.equal(executeTool(project, 'update_world_entry', {
  id: created.id, tags: ['city', 'city', 'future'], category: 'technology',
}).updated, true);
assert.equal(executeTool(project, 'delete_world_entry', { id: created.id }).deleted, true);
```

- [ ] **Step 2: Run the focused tests and observe missing-module/schema failures**

Run: `node --test server/tests/world-api.test.js server/tests/world-tools.test.js`

Expected: FAIL before the tag module and normalized tool output exist.

- [ ] **Step 3: Implement the shared tag module and use it at both mutation boundaries**

```js
function parseWorldTags(value) {
  if (Array.isArray(value)) return normalize(value);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return normalize(parsed);
  } catch {}
  return normalize(value.split(/[，,]/));
}

function serializeWorldTags(value) {
  return JSON.stringify(parseWorldTags(value));
}
```

Apply `serializeWorldTags` before REST insert/update and tool insert/update. Map `list_world` rows to parsed tag arrays. Add `technology` and array `tags` schemas to the AI function definitions.

- [ ] **Step 4: Re-run focused server tests**

Run: `node --test server/tests/world-api.test.js server/tests/world-tools.test.js`

Expected: PASS.

### Task 2: Add typed frontend world APIs and tag conversion

**Files:**
- Create: `src/lib/worldTags.ts`
- Create: `tests/worldTags.test.ts`
- Create: `tests/worldApi.test.ts`
- Modify: `src/types/index.ts:89-95`
- Modify: `src/lib/api.ts:1-8,242-249`

**Interfaces:**
- Produces `parseWorldTags(value: unknown): string[]` and `serializeWorldTags(tags: readonly string[]): string`.
- `worldApi.list(project): Promise<WorldEntry[]>`, `worldApi.create(project, data: WorldEntryInput)`, `worldApi.update(project, id, data: Partial<WorldEntryInput>)`, `worldApi.delete(project, id)`.

- [ ] **Step 1: Write failing frontend contract tests**

```ts
assert.deepEqual(parseWorldTags('["critical", "city"]'), ['critical', 'city'])
assert.equal(serializeWorldTags(['city', ' city ', '']), '["city"]')
await worldApi.update('Project / A', 'entry / 1', { name: 'Updated' })
assert.equal(calls[0].url, '/api/Project%20%2F%20A/world/entry%20%2F%201')
assert.equal(calls[0].method, 'PUT')
await assert.rejects(() => worldApi.delete('Project', 'missing'), ApiError)
```

- [ ] **Step 2: Run tests and observe `worldApi.update`/`delete` missing**

Run: `node --test tests/worldTags.test.ts tests/worldApi.test.ts`

Expected: FAIL because the API methods and tag module do not exist.

- [ ] **Step 3: Implement typed API methods and response conversion**

```ts
export const worldApi = {
  list: async (project: string): Promise<WorldEntry[]> => {
    const entries = await projectRequest(project, `/${encodeURIComponent(project)}/world`)
    return entries.map((entry: WorldEntry & { tags: unknown }) => ({ ...entry, tags: parseWorldTags(entry.tags) }))
  },
  update: (project: string, id: string, data: Partial<WorldEntryInput>) =>
    projectRequest(project, `/${encodeURIComponent(project)}/world/${encodeURIComponent(id)}`, { method: 'PUT', body: data }),
  delete: (project: string, id: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/world/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
```

- [ ] **Step 4: Re-run frontend contract tests**

Run: `node --test tests/worldTags.test.ts tests/worldApi.test.ts`

Expected: PASS.

### Task 3: Implement the accessible editor, deletion confirmation, and translations

**Files:**
- Modify: `src/components/SimpleCreateDialog.tsx:1-140`
- Modify: `src/pages/World.tsx:1-137`
- Modify: `src/i18n/zh.json:629-641`
- Modify: `src/i18n/en.json:629-641`

**Interfaces:**
- `SimpleCreateDialog` gains optional `footerStart?: ReactNode` for a destructive action.
- World page calls the Task 2 API and `notifyDataChanged('world', [id])` after successful mutations.

- [ ] **Step 1: Implement the dialog footer extension**

```tsx
<div className="flex gap-2 justify-between border-t border-[var(--hairline)] pt-4">
  <div>{footerStart}</div>
  <div className="flex gap-2">{/* cancel and submit buttons */}</div>
</div>
```

- [ ] **Step 2: Add world editor and confirmation state**

```tsx
const [editingEntry, setEditingEntry] = useState<WorldEntry | null>(null)
const [deleteTarget, setDeleteTarget] = useState<WorldEntry | null>(null)
const [deleting, setDeleting] = useState(false)
const [deleteError, setDeleteError] = useState('')
```

Render a prefilled `SimpleCreateDialog key={editingEntry.id}` with all fields, pass `footerStart` to request deletion, and render a second confirmation dialog that calls `worldApi.delete`. Use `technology` in creation, filtering and edit options. Ensure mutation success calls both `reload()` and `notifyDataChanged`.

- [ ] **Step 3: Add bilingual labels and error text**

Add `tags`, `tagsPlaceholder`, `editEntry`, `saveChanges`, `deleteEntry`, `editAction`, `deleteAction`, `deleteConfirmation`, and `deleteFailed` under `world` in both JSON files.

- [ ] **Step 4: Type-check and format affected code**

Run: `pnpm exec biome check --write src/components/SimpleCreateDialog.tsx src/pages/World.tsx src/lib/api.ts src/lib/worldTags.ts src/types/index.ts tests/worldTags.test.ts tests/worldApi.test.ts`

Run: `pnpm typecheck`

Expected: both commands exit 0.

### Task 4: Run full regression and manual acceptance

**Files:**
- Verify: all files above

- [ ] **Step 1: Run automated regression**

Run: `pnpm test:server`

Run: `node --test tests/worldTags.test.ts tests/worldApi.test.ts`

Run: `pnpm typecheck`

Expected: all exit 0.

- [ ] **Step 2: Perform manual UI acceptance**

1. Open a project with a seeded event tag and a `technology` entry.
2. Click its edit action, verify all values are prefilled and tags display comma-separated.
3. Change all four fields, save, and verify cards/tags update immediately and after reload.
4. Reopen the editor, choose delete, cancel once, then confirm deletion; verify the card disappears.
5. Force a missing-ID request and verify the relevant dialog remains open with an error.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check; git status --short`

Expected: no whitespace errors and only feature files plus pre-existing untracked skill directories.
