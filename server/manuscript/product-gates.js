'use strict';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OPTION_KEYS = Object.freeze([
  'projectSessionAdmission',
  'writerTurns',
  'freshness',
  'turnContextSource',
  'policy',
  'productWriteIntentAuthority',
]);
const WRITE_REQUEST_KEYS = Object.freeze(['logicalRequestId', 'policyInput', 'writeIntent']);
const TURN_CONTEXT_KEYS = Object.freeze([
  'journalId',
  'logicalRequestId',
  'projectedAt',
  'currentProjection',
  'fileSnapshot',
  'ignoredLedger',
]);

const gateRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataDescriptors(value, keys, label, frozen = false) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  if (frozen && !Object.isFrozen(value)) invalid(`${label} must be frozen`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || actualKeys.map(String).sort().some((key, index) => key !== expectedKeys[index])
  ) {
    invalid(`${label} has an inexact key set`);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label} must contain enumerable own data properties only`);
    }
  }
  return descriptors;
}

function descriptorValue(descriptors, key) {
  return descriptors[key].value;
}

function exactMethodPort(value, methods, label) {
  const descriptors = exactDataDescriptors(value, methods, label);
  const port = { receiver: value };
  for (const method of methods) {
    const implementation = descriptorValue(descriptors, method);
    if (typeof implementation !== 'function') invalid(`${label}.${method} must be a function`);
    port[method] = implementation;
  }
  return Object.freeze(port);
}

function invoke(port, method, args) {
  return Reflect.apply(port[method], port.receiver, args);
}

function assertDeepFrozenPlainData(value, label, active = new WeakSet()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))
  ) {
    return;
  }
  if (
    value === null
    || typeof value !== 'object'
    || !Object.isFrozen(value)
    || active.has(value)
  ) {
    invalid(`${label} must be recursively frozen finite plain data`);
  }
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalid(`${label} must be a plain array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')
        ) {
          invalid(`${label} must be a dense data array`);
        }
        assertDeepFrozenPlainData(descriptor.value, `${label}[${index}]`, active);
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string'
          || !/^(0|[1-9][0-9]*)$/u.test(key)
          || Number(key) >= value.length
        ) {
          invalid(`${label} has an invalid array property`);
        }
      }
      return;
    }
    if (!isPlainObject(value)) invalid(`${label} must contain plain data`);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string'
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) {
        invalid(`${label} must contain enumerable string data properties only`);
      }
      assertDeepFrozenPlainData(descriptor.value, `${label}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function validateWriteRequest(writeRequest) {
  const descriptors = exactDataDescriptors(
    writeRequest,
    WRITE_REQUEST_KEYS,
    'writeRequest',
    true,
  );
  const logicalRequestId = descriptorValue(descriptors, 'logicalRequestId');
  if (typeof logicalRequestId !== 'string' || logicalRequestId.length === 0) {
    invalid('writeRequest.logicalRequestId must be a non-empty string');
  }
  return Object.freeze({
    logicalRequestId,
    policyInput: descriptorValue(descriptors, 'policyInput'),
    writeIntent: descriptorValue(descriptors, 'writeIntent'),
  });
}

function validateProductIntentDescriptor(value) {
  const descriptors = exactDataDescriptors(
    value,
    ['family', 'logicalInputDigest'],
    'product write intent descriptor',
    true,
  );
  const family = descriptorValue(descriptors, 'family');
  const logicalInputDigest = descriptorValue(descriptors, 'logicalInputDigest');
  if (family === 'ordinary_create') {
    if (typeof logicalInputDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(logicalInputDigest)) {
      invalid('ordinary_create intent requires a lowercase SHA-256 logical digest');
    }
  } else if (family === 'non_create' || family === 'orphan_resolution') {
    if (logicalInputDigest !== null) invalid(`${family} intent must not provide a logical digest`);
  } else {
    invalid('product write intent family is invalid');
  }
  return Object.freeze({ family, logicalInputDigest });
}

function validateTurnContext(turnContext, logicalRequestId) {
  const descriptors = exactDataDescriptors(
    turnContext,
    TURN_CONTEXT_KEYS,
    'turnContext',
    true,
  );
  const journalId = descriptorValue(descriptors, 'journalId');
  if (typeof journalId !== 'string' || !UUID_V4_PATTERN.test(journalId)) {
    invalid('turnContext.journalId must be a canonical lowercase UUIDv4');
  }
  const returnedLogicalRequestId = descriptorValue(descriptors, 'logicalRequestId');
  if (returnedLogicalRequestId !== logicalRequestId) {
    invalid('turnContext.logicalRequestId must echo the write request exactly');
  }
  const projectedAt = descriptorValue(descriptors, 'projectedAt');
  if (
    typeof projectedAt !== 'string'
    || !CANONICAL_TIME_PATTERN.test(projectedAt)
    || Number.isNaN(Date.parse(projectedAt))
    || new Date(projectedAt).toISOString() !== projectedAt
  ) {
    invalid('turnContext.projectedAt must be a canonical UTC millisecond timestamp');
  }
  for (const key of ['currentProjection', 'fileSnapshot', 'ignoredLedger']) {
    assertDeepFrozenPlainData(descriptorValue(descriptors, key), `turnContext.${key}`);
  }
  const fileSnapshot = descriptorValue(descriptors, 'fileSnapshot');
  if (fileSnapshot === null || typeof fileSnapshot !== 'object') {
    invalid('turnContext.fileSnapshot must be an opaque frozen Store snapshot');
  }
  return turnContext;
}

function validatePolicyResult(result) {
  const descriptors = exactDataDescriptors(
    result,
    ['disposition'],
    'policy result',
    true,
  );
  if (descriptorValue(descriptors, 'disposition') !== 'ALLOWED') {
    invalid('policy did not allow the write');
  }
}

function gateRecord(value) {
  const record = gateRecords.get(value);
  if (record === undefined) invalid('product gates authority is invalid');
  return record;
}

function sameResult(left, right) {
  return Object.is(left, right);
}

async function withSingleAdmission(record, projectSelector, methodName, operation) {
  let callbackWindowOpen = true;
  let callbackCalls = 0;
  let callbackResult;
  let callbackSettled = false;
  let returned;
  try {
    returned = await invoke(record.projectSessionAdmission, methodName, [
      projectSelector,
      async (admission) => {
        if (!callbackWindowOpen) {
          invalid('projectSessionAdmission callback was invoked after the port settled');
        }
        callbackCalls += 1;
        if (callbackCalls !== 1) {
          invalid('projectSessionAdmission invoked its callback more than once');
        }
        callbackResult = await operation(admission);
        callbackSettled = true;
        return callbackResult;
      },
    ]);
  } finally {
    callbackWindowOpen = false;
  }
  if (
    callbackCalls !== 1
    || !callbackSettled
    || !sameResult(returned, callbackResult)
  ) {
    invalid('projectSessionAdmission must return its single callback result');
  }
  return returned;
}

async function withSingleWriterTurn(record, admission, operation) {
  let callbackWindowOpen = true;
  let callbackCalls = 0;
  let callbackResult;
  let callbackSettled = false;
  let returned;
  try {
    returned = await invoke(record.writerTurns, 'withWriterTurn', [
      admission,
      async (writerTurn) => {
        if (!callbackWindowOpen) {
          invalid('writerTurns callback was invoked after the port settled');
        }
        callbackCalls += 1;
        if (callbackCalls !== 1) invalid('writerTurns invoked its callback more than once');
        callbackResult = await operation(writerTurn);
        callbackSettled = true;
        return callbackResult;
      },
    ]);
  } finally {
    callbackWindowOpen = false;
  }
  if (
    callbackCalls !== 1
    || !callbackSettled
    || !sameResult(returned, callbackResult)
  ) {
    invalid('writerTurns must return its single callback result');
  }
  return returned;
}

function createManuscriptProductGates(options) {
  const optionDescriptors = exactDataDescriptors(
    options,
    OPTION_KEYS,
    'createManuscriptProductGates options',
  );
  const record = Object.freeze({
    projectSessionAdmission: exactMethodPort(
      descriptorValue(optionDescriptors, 'projectSessionAdmission'),
      ['withAdmission', 'withOrphanAdmission'],
      'projectSessionAdmission',
    ),
    writerTurns: exactMethodPort(
      descriptorValue(optionDescriptors, 'writerTurns'),
      ['withWriterTurn'],
      'writerTurns',
    ),
    freshness: exactMethodPort(
      descriptorValue(optionDescriptors, 'freshness'),
      ['ensureProjectionCurrentForWrite', 'ensureReadableProjection'],
      'freshness',
    ),
    turnContextSource: exactMethodPort(
      descriptorValue(optionDescriptors, 'turnContextSource'),
      ['capture', 'captureOrphanBaseline'],
      'turnContextSource',
    ),
    policy: exactMethodPort(
      descriptorValue(optionDescriptors, 'policy'),
      ['authorizeWrite'],
      'policy',
    ),
    productWriteIntentAuthority: exactMethodPort(
      descriptorValue(optionDescriptors, 'productWriteIntentAuthority'),
      ['assert', 'describe'],
      'productWriteIntentAuthority',
    ),
  });

  const gates = {
    async withCurrentManuscriptWriteTurn(projectSelector, writeRequest, callback) {
      const current = gateRecord(this);
      const request = validateWriteRequest(writeRequest);
      if (typeof callback !== 'function') invalid('write callback must be a function');
      const assertedIntent = invoke(current.productWriteIntentAuthority, 'assert', [
        request.writeIntent,
      ]);
      if (assertedIntent !== request.writeIntent) {
        invalid('product write intent authority must preserve the original intent');
      }
      const intentDescriptor = validateProductIntentDescriptor(invoke(
        current.productWriteIntentAuthority,
        'describe',
        [request.writeIntent],
      ));
      let admissionMethod = 'withAdmission';
      if (intentDescriptor.family === 'orphan_resolution') {
        const reassertedIntent = invoke(current.productWriteIntentAuthority, 'assert', [
          request.writeIntent,
        ]);
        if (reassertedIntent !== request.writeIntent) {
          invalid('product write intent authority must preserve the orphan intent');
        }
        const recheckedDescriptor = validateProductIntentDescriptor(invoke(
          current.productWriteIntentAuthority,
          'describe',
          [request.writeIntent],
        ));
        if (
          recheckedDescriptor.family !== intentDescriptor.family
          || recheckedDescriptor.logicalInputDigest !== intentDescriptor.logicalInputDigest
        ) invalid('product write intent descriptor changed before orphan admission');
        admissionMethod = 'withOrphanAdmission';
      }
      return withSingleAdmission(current, projectSelector, admissionMethod, (admission) => (
        withSingleWriterTurn(current, admission, async (writerTurn) => {
          await invoke(current.freshness, 'ensureProjectionCurrentForWrite', [
            admission,
            writerTurn,
            Object.freeze({
              logicalRequestId: request.logicalRequestId,
              writeIntent: request.writeIntent,
            }),
          ]);
          const contextInput = Object.freeze({
            admission,
            writerTurn,
            logicalRequestId: request.logicalRequestId,
          });
          const turnContext = validateTurnContext(
            await invoke(
              current.turnContextSource,
              intentDescriptor.family === 'orphan_resolution'
                ? 'captureOrphanBaseline'
                : 'capture',
              [contextInput],
            ),
            request.logicalRequestId,
          );
          const policyInput = Object.freeze({
            admission,
            writerTurn,
            policyInput: request.policyInput,
            turnContext,
          });
          validatePolicyResult(
            await invoke(current.policy, 'authorizeWrite', [policyInput]),
          );
          return Reflect.apply(callback, undefined, [turnContext]);
        })
      ));
    },

    async withReadableManuscriptProjection(projectSelector, query) {
      const current = gateRecord(this);
      return withSingleAdmission(current, projectSelector, 'withAdmission', (admission) => (
        invoke(current.freshness, 'ensureReadableProjection', [admission, query])
      ));
    },
  };
  gateRecords.set(gates, record);
  return Object.freeze(gates);
}

module.exports = {
  createManuscriptProductGates,
};
