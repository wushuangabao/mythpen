'use strict';

const { assertCanonicalUuid } = require('./contracts');
const { canonicalSchema12ReuseIdentityPlan } = require('./projection-store');

const ACTIONS = new Set(['ignore_in_place', 'revoke_ignore']);
const RESOURCE_KINDS = new Set(['chapter', 'volume']);
const NOOP_RESULT = Object.freeze({ state: 'noop' });
const serviceRecords = new WeakMap();
const requestRecords = new WeakMap();
const preparedRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDescriptors(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid(`${label} must contain enumerable data properties only`);
    }
  }
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) invalid(`${label} has an inexact key set`);
  return descriptors;
}

function requirePort(value, methods, label) {
  if (
    value === null
    || (typeof value !== 'object' && typeof value !== 'function')
    || methods.some((method) => typeof value[method] !== 'function')
  ) invalid(`${label} is invalid`);
  return value;
}

class OrphanResolutionService {
  constructor(options) {
    const descriptors = exactDescriptors(
      options,
      ['manuscriptStore', 'projectionStore', 'projectStore'],
      'OrphanResolutionService options',
    );
    const manuscriptStore = requirePort(
      descriptors.manuscriptStore.value,
      ['preflightOrphanResolution', 'describeOrphanResolution'],
      'manuscriptStore',
    );
    const projectionStore = requirePort(
      descriptors.projectionStore.value,
      ['buildResolutionTarget', 'publishResolution', 'verifyResolutionNoop'],
      'projectionStore',
    );
    const projectStore = requirePort(
      descriptors.projectStore.value,
      ['inspectProjectionTarget', 'readAll', 'publishProjectionTarget'],
      'projectStore',
    );
    serviceRecords.set(this, Object.freeze({ manuscriptStore, projectionStore, projectStore }));
    Object.freeze(this);
  }

  snapshotRequest(request) {
    const descriptors = exactDescriptors(request, ['kind', 'uid'], 'orphan request');
    const kind = descriptors.kind.value;
    if (!RESOURCE_KINDS.has(kind)) invalid('orphan request.kind is invalid');
    const uid = assertCanonicalUuid(descriptors.uid.value, 'orphan request.uid');
    const snapshot = Object.freeze({ kind, uid });
    requestRecords.set(snapshot, this);
    return snapshot;
  }

  async preflightResolution(action, request, baselineContext) {
    if (!ACTIONS.has(action)) invalid('orphan resolution action is invalid');
    if (requestRecords.get(request) !== this) {
      invalid('preflightResolution requires the original service request');
    }
    const service = serviceRecords.get(this);
    const storePrepared = await service.manuscriptStore.preflightOrphanResolution(
      action,
      request,
      baselineContext,
    );
    const description = service.manuscriptStore.describeOrphanResolution(storePrepared);
    if (
      description.action !== action
      || description.requestKind !== request.kind
      || description.requestUid !== request.uid
      || description.currentProjection.projectUid !== description.candidate.projectUid
      || description.targetGeneration !== description.currentProjection.basis.baseGeneration + 1
    ) invalid('Store orphan prepared candidate is inconsistent');
    const prepared = Object.freeze({});
    preparedRecords.set(prepared, {
      beforeRows: description.beforeRows,
      candidate: description.candidate,
      consumed: false,
      currentProjection: description.currentProjection,
      noOp: description.noOp,
      service: this,
      targetGeneration: description.targetGeneration,
      transition: description.transition,
    });
    return prepared;
  }

  publishResolution(preparedResolution, projectionContext) {
    const prepared = preparedRecords.get(preparedResolution);
    if (prepared === undefined || prepared.service !== this) {
      invalid('publishResolution requires the original prepared resolution');
    }
    if (prepared.consumed) invalid('prepared resolution is stale');
    if (!Object.isFrozen(projectionContext)) {
      invalid('projectionContext must be frozen');
    }
    const context = exactDescriptors(
      projectionContext,
      ['currentProjection', 'projectedAt'],
      'projectionContext',
    );
    if (context.currentProjection.value !== prepared.currentProjection) {
      invalid('projectionContext requires the original projection');
    }
    const service = serviceRecords.get(this);
    const localIdentityPlan = canonicalSchema12ReuseIdentityPlan(prepared.currentProjection);
    const target = service.projectionStore.buildResolutionTarget({
      candidate: prepared.candidate,
      currentProjection: prepared.currentProjection,
      targetGeneration: prepared.targetGeneration,
      projectedAt: context.projectedAt.value,
      ignoredLedger: prepared.beforeRows,
      localIdentityPlan,
      resolutionTransition: prepared.transition,
    });
    prepared.consumed = true;
    if (prepared.noOp) {
      service.projectionStore.verifyResolutionNoop({
        projectStore: service.projectStore,
        target,
      });
      return NOOP_RESULT;
    }
    return service.projectionStore.publishResolution({
      projectStore: service.projectStore,
      target,
    });
  }
}

module.exports = {
  OrphanResolutionService,
};
