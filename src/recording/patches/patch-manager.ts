
import type { AsyncLocalStorage } from 'node:async_hooks';

import { install as installIoredisPatch } from './ioredis';
import { install as installMongodbPatch } from './mongodb';
import { install as installMysql2Patch } from './mysql2';
import { install as installPgPatch } from './pg';
import type { IOEventSlot, RequestContext, ResolvedConfig } from '../../types';
import type { RecorderState } from '../../sdk-diagnostics';

const OWNED_METHODS = Symbol('errorcore.ownedMethods');
const SDK_WRAPPER_OWNER = Symbol('errorcore.sdkWrapperOwner');
const SDK_WRAPPED_METHOD = Symbol('errorcore.sdkWrappedMethod');
const SDK_WRAPPER_PREDECESSOR = Symbol('errorcore.sdkWrapperPredecessor');

type WrappedTarget = Record<string | symbol, unknown> & {
  [OWNED_METHODS]?: Map<string, Function>;
};

type Wrapper = (original: Function) => Function;

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
  getStore?: () => AsyncLocalStorage<RequestContext>;
}

export interface PatchInstallDeps {
  buffer: IOEventBufferLike;
  als: ALSManagerLike;
  config: ResolvedConfig;
  /**
   * When set, the installer MUST patch methods on this reference instead of
   * resolving the driver via nodeRequire(). Used for webpack-bundled
   * environments where the app's bundled copy of the driver is distinct from
   * what nodeRequire() would return. Passed through from config.drivers by
   * PatchManager.
   */
  explicitDriver?: unknown;
}

type OwnedWrapperFunction = Function & {
  [SDK_WRAPPER_OWNER]?: true;
  [SDK_WRAPPED_METHOD]?: string;
  [SDK_WRAPPER_PREDECESSOR]?: Function;
};

function getOwnedMethodStore(target: WrappedTarget): Map<string, Function> {
  if (target[OWNED_METHODS] === undefined) {
    Object.defineProperty(target, OWNED_METHODS, {
      value: new Map<string, Function>(),
      configurable: true,
      enumerable: false,
      writable: false
    });
  }

  return target[OWNED_METHODS] as Map<string, Function>;
}

function getOwnedWrapperMetadata(
  candidate: unknown,
  methodName: string
): { predecessor: Function } | null {
  if (typeof candidate !== 'function') {
    return null;
  }

  const wrapper = candidate as OwnedWrapperFunction;

  if (
    wrapper[SDK_WRAPPER_OWNER] !== true ||
    wrapper[SDK_WRAPPED_METHOD] !== methodName ||
    typeof wrapper[SDK_WRAPPER_PREDECESSOR] !== 'function'
  ) {
    return null;
  }

  return {
    predecessor: wrapper[SDK_WRAPPER_PREDECESSOR] as Function
  };
}

function markOwnedWrapper(
  wrapper: Function,
  methodName: string,
  predecessor: Function
): Function {
  const ownedWrapper = wrapper as OwnedWrapperFunction;
  Object.defineProperty(ownedWrapper, SDK_WRAPPER_OWNER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(ownedWrapper, SDK_WRAPPED_METHOD, {
    value: methodName,
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(ownedWrapper, SDK_WRAPPER_PREDECESSOR, {
    value: predecessor,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return wrapper;
}

export function installOwnedWrapper(
  target: object,
  methodName: string,
  wrapperFactory: Wrapper
): { wrapper: Function; restore: () => void } | null {
  const wrappedTarget = target as WrappedTarget;
  const current = wrappedTarget[methodName];

  if (typeof current !== 'function') {
    return null;
  }

  const predecessor = getOwnedWrapperMetadata(current, methodName)?.predecessor ?? current;
  const next = wrapperFactory(predecessor);

  if (typeof next !== 'function') {
    return null;
  }

  const ownedWrapper = markOwnedWrapper(next, methodName, predecessor);
  wrappedTarget[methodName] = ownedWrapper;

  return {
    wrapper: ownedWrapper,
    restore: () => {
      const latest = wrappedTarget[methodName];

      if (latest === ownedWrapper) {
        wrappedTarget[methodName] = predecessor;
      }
    }
  };
}

export function wrapMethod(target: object, methodName: string, wrapper: Wrapper): void {
  const wrappedTarget = target as WrappedTarget;
  const store = getOwnedMethodStore(wrappedTarget);
  const installation = installOwnedWrapper(target, methodName, wrapper);

  if (installation === null) {
    return;
  }

  store.set(methodName, installation.wrapper);
}

export function unwrapMethod(target: object, methodName: string): void {
  const wrappedTarget = target as WrappedTarget;
  const store = wrappedTarget[OWNED_METHODS];

  if (store === undefined) {
    return;
  }

  const wrapper = store.get(methodName);

  if (wrapper === undefined) {
    return;
  }

  const metadata = getOwnedWrapperMetadata(wrapper, methodName);
  const current = wrappedTarget[methodName];

  if (metadata !== null && current === wrapper) {
    wrappedTarget[methodName] = metadata.predecessor;
  }

  store.delete(methodName);
}

export class PatchManager {
  private readonly deps: PatchInstallDeps;

  private readonly recorderStates: Record<string, RecorderState> = {};

  private uninstallers: Array<() => void> = [];

  public constructor(deps: PatchInstallDeps) {
    this.deps = deps;
  }

  public installAll(): void {
    const { drivers } = this.deps.config;
    const pg = installPgPatch({ ...this.deps, explicitDriver: drivers.pg });
    const mysql2 = installMysql2Patch({ ...this.deps, explicitDriver: drivers.mysql2 });
    const ioredis = installIoredisPatch({ ...this.deps, explicitDriver: drivers.ioredis });
    const mongodb = installMongodbPatch({ ...this.deps, explicitDriver: drivers.mongodb });
    this.uninstallers = [pg.uninstall, mysql2.uninstall, ioredis.uninstall, mongodb.uninstall];
    this.recorderStates.pg = pg.state;
    this.recorderStates.mysql2 = mysql2.state;
    this.recorderStates.ioredis = ioredis.state;
    this.recorderStates.mongodb = mongodb.state;
  }

  public getRecorderStates(): Record<string, RecorderState> {
    return { ...this.recorderStates };
  }

  public unwrapAll(): void {
    while (this.uninstallers.length > 0) {
      this.uninstallers.pop()?.();
    }
  }
}
