const { createHash, randomUUID } = require('node:crypto');

const { classifyNativeSql } = require('./native-sql-authorization');
const { classifyChapterBodyMutation } = require('../manuscript-sql-guard');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function createNativeDbAdapter({
  controlStore,
  coordinator,
  databasePath,
  nativeStore,
  validateManuscriptSqlScope,
}) {
  if (
    !controlStore
    || !coordinator
    || typeof databasePath !== 'string'
    || !nativeStore
    || typeof validateManuscriptSqlScope !== 'function'
  ) {
    throw new TypeError('Native database adapter dependencies are incomplete');
  }
  let closed = false;
  let activeTransaction = null;
  let activeManuscript = null;
  let pendingBodyAuthorization = null;
  const admission = controlStore.read().findLast((event) => (
    event.type === 'sqlite.native.activation.activated'
  ));
  if (!admission) throw adapterError('NATIVE_ADMISSION_REJECTED', 'Activated admission is missing');
  const immutable = Object.freeze({
    dbKey: admission.payload.dbKey,
    ownershipHash: admission.payload.ownershipHash,
    projectInstanceIdSha256: admission.payload.projectInstanceIdSha256,
  });

  function assertOpen() {
    if (closed) throw adapterError('NATIVE_CONNECTION_RELEASED', 'Native database adapter is closed');
  }

  function execute(sql, params, mode) {
    assertOpen();
    const classification = classifyNativeSql(sql);
    if (activeTransaction) {
      assertBodySqlAllowed(sql, params);
      return activeTransaction.statements[mode](sql, ...params);
    }
    if (classification.kind !== 'business_read') {
      assertGenericSqlAllowed(sql);
      return runGenericTransaction(
        () => activeTransaction.statements[mode](sql, ...params),
      );
    }
    const read = () => mode === 'all'
      ? nativeStore.readAll(sql, ...params)
      : nativeStore.readGet(sql, ...params);
    return coordinator.withProjectRecoveryLeaseSync
      ? coordinator.withProjectRecoveryLeaseSync(databasePath, read)
      : read();
  }

  function statement(sql) {
    return Object.freeze({
      all(...params) { return execute(sql, params, 'all'); },
      get(...params) { return execute(sql, params, 'get'); },
      run(...params) {
        assertOpen();
        classifyNativeSql(sql);
        if (!activeTransaction) {
          assertGenericSqlAllowed(sql);
          return runGenericTransaction(
            () => activeTransaction.statements.run(sql, ...params),
          );
        }
        assertBodySqlAllowed(sql, params);
        return activeTransaction.statements.run(sql, ...params);
      },
    });
  }

  function exactIntent(intent) {
    const keys = [
      'bodyBytes', 'bodySha256', 'chapterId', 'chapterNumber', 'expectedBodySha256',
      'expectedDataVersion', 'operation', 'source', 'targetKind', 'version', 'volumeId',
    ];
    if (!Object.isFrozen(intent) || Object.keys(intent).sort().join(',') !== keys.sort().join(',')) {
      throw adapterError('MANUSCRIPT_SOURCE_EVENT_INVALID', 'Native manuscript intent is inexact');
    }
    return intent;
  }

  function sourcePayload(descriptor) {
    const connectionEpoch = nativeStore.connectionEpoch;
    return Object.freeze({
      version: 1,
      eventId: randomUUID(),
      dbKey: immutable.dbKey,
      projectInstanceIdSha256: immutable.projectInstanceIdSha256,
      createdAt: new Date().toISOString(),
      ownershipHash: immutable.ownershipHash,
      connectionEpoch,
      logicalRequestDigest: descriptor.logicalRequestDigest,
      attemptSeq: 1,
      previousAttemptSourceDigest: null,
      operationKind: descriptor.operationKind,
      targetKind: descriptor.targetKind,
      targetIdSha256: descriptor.targetIdSha256,
      expectedDataVersion: descriptor.expectedDataVersion,
    });
  }

  function runOwnedTransaction(descriptor, intent, callback) {
    assertOpen();
    if (activeTransaction) throw adapterError('NESTED_TRANSACTION', 'Nested transactions are not supported');
    return coordinator.withProjectLogicalRequestSync(databasePath, (context) => {
      context.assertLease();
      const tail = controlStore.tail();
      const payload = sourcePayload(descriptor);
      const source = controlStore.compareAndAppend(tail?.digest ?? null, {
        type: 'manuscript.source',
        payload,
      });
      return nativeStore.executeTransaction({
        sourceDigest: source.digest,
        operationKind: payload.operationKind,
        logicalRequestDigest: payload.logicalRequestDigest,
        attemptSeq: payload.attemptSeq,
      }, (statements) => {
        activeTransaction = { intent, source, statements };
        try {
          const result = callback(adapter);
          if (isThenable(result)) {
            void Promise.resolve(result).catch(() => {});
            throw adapterError('ASYNC_TRANSACTION_CALLBACK', 'Transaction callbacks must be synchronous');
          }
          return result;
        } finally {
          activeTransaction = null;
          activeManuscript = null;
          pendingBodyAuthorization = null;
        }
      });
    });
  }

  function runGenericTransaction(callback) {
    const nonce = randomUUID();
    return runOwnedTransaction(Object.freeze({
      logicalRequestDigest: sha256(`native-project-write:${nonce}`),
      operationKind: 'project_structure_write',
      targetKind: 'project',
      targetIdSha256: null,
      expectedDataVersion: null,
    }), null, callback);
  }

  function manuscriptRequired() {
    return adapterError('MANUSCRIPT_SERVICE_REQUIRED', 'Chapter body writes must use ManuscriptService');
  }

  function assertGenericSqlAllowed(sql) {
    if (classifyChapterBodyMutation(sql)) throw manuscriptRequired();
  }

  function assertBodySqlAllowed(sql, params) {
    const classification = classifyChapterBodyMutation(sql);
    const authorization = pendingBodyAuthorization;
    if (!classification) {
      if (authorization) {
        pendingBodyAuthorization = null;
        throw manuscriptRequired();
      }
      return;
    }
    pendingBodyAuthorization = null;
    if (!authorization || !Array.isArray(params)) throw manuscriptRequired();
    if (!validateManuscriptSqlScope(authorization.scope, classification, params)) {
      throw manuscriptRequired();
    }
  }

  const adapter = {
    prepare: statement,
    transaction(callback) {
      if (typeof callback !== 'function') throw new TypeError('Transaction callback must be a function');
      return (...args) => {
        if (activeTransaction) throw adapterError('NESTED_TRANSACTION', 'Nested transactions are not supported');
        return runGenericTransaction(() => callback(...args));
      };
    },
    runManuscriptTransaction(projectName, intent, callback) {
      exactIntent(intent);
      if (typeof projectName !== 'string' || typeof callback !== 'function') {
        throw new TypeError('Native manuscript transaction input is invalid');
      }
      activeManuscript = { projectName };
      return runOwnedTransaction(Object.freeze({
        logicalRequestDigest: sha256(JSON.stringify(intent)),
        operationKind: 'chapter_body_write',
        targetKind: intent.targetKind,
        targetIdSha256: intent.chapterId === null
          ? sha256(JSON.stringify({
            chapterNumber: intent.chapterNumber,
            volumeId: intent.volumeId,
          }))
          : sha256(String(intent.chapterId)),
        expectedDataVersion: intent.expectedDataVersion,
      }), intent, callback);
    },
    get manuscriptTransactionCapability() {
      return manuscriptCapability;
    },
    flush() { assertOpen(); },
    close() { if (!closed) nativeStore.close(); closed = true; },
    _discard() { if (!closed) nativeStore.close(); closed = true; },
    _fenceForLeaseLoss() { if (!closed) nativeStore.fence(); closed = true; },
    _recoverForProjectWrite() { return nativeStore.recover(); },
    _flushInProjectWrite() { assertOpen(); },
    _settleManuscriptPublicationFailureInProjectWrite() {},
  };

  const claims = new WeakMap();
  function eventTargetMatchesIntent(intent, payload, scope) {
    if (
      payload?.operation !== scope.operation
      || payload?.source !== scope.source
      || payload?.chapterId !== scope.chapterId
      || payload?.chapterNumber !== scope.chapterNumber
      || payload?.volumeId !== scope.volumeId
    ) {
      return false;
    }
    if (intent.operation === 'create') {
      return payload.chapterId === null
        && payload.volumeId === intent.volumeId
        && (intent.chapterNumber === null || payload.chapterNumber === intent.chapterNumber);
    }
    return Number.isSafeInteger(payload.chapterId)
      && payload.chapterId > 0
      && payload.chapterNumber === null
      && payload.volumeId === null
      && (intent.chapterId === null || payload.chapterId === intent.chapterId);
  }

  const manuscriptCapability = Object.freeze({
    assertActive(_projectName, projectDb) {
      if (projectDb !== adapter || !activeTransaction || !activeManuscript) {
        throw adapterError('MANUSCRIPT_TRANSACTION_REQUIRED', 'Native manuscript transaction is not active');
      }
      return true;
    },
    claim(projectName, projectDb, scope) {
      this.assertActive(projectName, projectDb);
      const claim = Object.freeze(Object.create(null));
      claims.set(claim, { scope, transaction: activeTransaction });
      return claim;
    },
    appendSourceEvent(projectName, projectDb, claim, event) {
      this.assertActive(projectName, projectDb);
      const descriptor = claims.get(claim);
      claims.delete(claim);
      const intent = activeTransaction.intent;
      const payload = event?.payload;
      if (
        !descriptor
        || descriptor.transaction !== activeTransaction
        || event?.type !== 'manuscript.body_mutation.attempt'
        || (intent.operation !== 'append' && payload?.bodyBytes !== intent.bodyBytes)
        || (intent.operation !== 'append' && payload?.bodySha256 !== intent.bodySha256)
        || !eventTargetMatchesIntent(intent, payload, descriptor.scope)
        || payload?.expectedBodySha256 !== intent.expectedBodySha256
        || (intent.expectedDataVersion !== null
          && payload?.expectedDataVersion !== intent.expectedDataVersion)
        || payload?.operation !== intent.operation
        || payload?.source !== intent.source
      ) {
        throw adapterError('MANUSCRIPT_SOURCE_EVENT_INVALID', 'Native manuscript event differs from frozen intent');
      }
      pendingBodyAuthorization = Object.freeze({ scope: descriptor.scope });
      return activeTransaction.source;
    },
  });

  return Object.freeze(adapter);
}

module.exports = { createNativeDbAdapter };
