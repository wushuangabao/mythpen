const assert = require('node:assert/strict');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function callApi(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('project-data routes remain reachable when the project is named projects', {
  timeout: 15_000,
}, async (t) => {
  withIsolatedDataDir(t);

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  await db.initDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const projectsProject = await callApi(baseUrl, '/projects', {
    method: 'POST',
    body: { name: 'projects' },
  });
  assert.equal(projectsProject.status, 200);

  const createdChapter = await callApi(baseUrl, '/projects/chapters', {
    method: 'POST',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
    body: { title: 'Reserved-name chapter' },
  });
  assert.equal(createdChapter.status, 201);

  const chapterList = await callApi(baseUrl, '/projects/chapters', {
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(chapterList.status, 200);
  assert.equal(chapterList.body.length, 1);
  assert.equal(chapterList.body[0].title, 'Reserved-name chapter');

  const chaptersProject = await callApi(baseUrl, '/projects', {
    method: 'POST',
    body: { name: 'chapters' },
  });
  assert.equal(chaptersProject.status, 200);
  const metadata = await callApi(baseUrl, '/projects/by-name/chapters', {
    headers: { 'X-Mythpen-Project-Instance': chaptersProject.body.instanceId },
  });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.name, 'chapters');
  assert.equal(metadata.body.project_instance_id, chaptersProject.body.instanceId);

  for (const reservedResourceName of ['cover', 'target-words']) {
    const created = await callApi(baseUrl, '/projects', {
      method: 'POST',
      body: { name: reservedResourceName },
    });
    assert.equal(created.status, 200);
  }

  const uploadedCover = await callApi(baseUrl, '/projects/cover', {
    method: 'POST',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
    body: { data: Buffer.from('reserved-name-cover').toString('base64'), mime: 'image/png' },
  });
  assert.equal(uploadedCover.status, 200);

  const deletedCover = await callApi(baseUrl, '/projects/cover', {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(deletedCover.status, 200);

  const resetTargetWords = await callApi(baseUrl, '/projects/target-words', {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(resetTargetWords.status, 200);

  for (const reservedResourceName of ['cover', 'target-words']) {
    const stillPresent = await callApi(baseUrl, `/projects/by-name/${reservedResourceName}`);
    assert.equal(stillPresent.status, 200);
    assert.equal(stillPresent.body.name, reservedResourceName);
  }

  const deletedProjectsProject = await callApi(baseUrl, '/projects/by-name/projects', {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(deletedProjectsProject.status, 200);
});

test('reserved project names reach fixed diagnostics routes without the project param guard', {
  timeout: 15_000,
}, async (t) => {
  withIsolatedDataDir(t);

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const {
    jsonErrorMiddleware,
    jsonNotFoundMiddleware,
  } = require('../json-error-middleware');
  let server;
  const originalRunWithProjectInstance = db.runWithProjectInstance;
  let projectParamCalls = 0;

  t.after(async () => {
    db.runWithProjectInstance = originalRunWithProjectInstance;
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  await db.initDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(jsonNotFoundMiddleware);
  app.use(jsonErrorMiddleware);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  const reservedNames = [
    'projects',
    'chapters',
    'cover',
    'target-words',
    'diagnostics',
    'recover',
    'export',
  ];

  for (const name of reservedNames) {
    const created = await callApi(baseUrl, '/projects', {
      method: 'POST',
      body: { name },
    });
    assert.equal(created.status, 200, name);
  }
  db.runWithProjectInstance = (...args) => {
    projectParamCalls += 1;
    return originalRunWithProjectInstance(...args);
  };

  for (const name of reservedNames) {
    const diagnostics = await callApi(
      baseUrl,
      `/projects/by-name/${name}/diagnostics`,
    );
    assert.equal(diagnostics.status, 200, `${name} GET diagnostics`);
    assert.equal(diagnostics.body.state, 'ready');

    const recover = await callApi(
      baseUrl,
      `/projects/by-name/${name}/diagnostics/recover`,
      {
        method: 'POST',
        body: {
          action: 'recover_transaction',
          snapshot: diagnostics.body.snapshot,
        },
      },
    );
    assert.equal(recover.status, 409, `${name} POST recover`);
    assert.equal(recover.body.error.code, 'NATIVE_ACTIVATION_DISABLED');

    const exported = await callApi(
      baseUrl,
      `/projects/by-name/${name}/diagnostics/export`,
      { method: 'POST', body: {} },
    );
    assert.equal(exported.status, 200, `${name} POST export`);
    assert.deepEqual(Object.keys(exported.body), ['filename']);
  }
  assert.equal(projectParamCalls, 0);
});
