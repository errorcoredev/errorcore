
import type { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { install as installIoredisPatch } from './ioredis';
import { install as installMongodbPatch } from './mongodb';
import { install as installMysql2Patch } from './mysql2';
import { install as installPgPatch } from './pg';
import type { IOEventSlot, RequestContext, ResolvedConfig } from '../../types';
import type { RecorderState } from '../../sdk-diagnostics';

const appRequire = createRequire(path.join(process.cwd(), 'noop.js'));

const OWNED_METHODS = Symbol('errorcore.ownedMethods');
const SDK_WRAPPER_OWNER = Symbol('errorcore.sdkWrapperOwner');
const SDK_WRAPPED_METHOD = Symbol('errorcore.sdkWrappedMethod');
const SDK_WRAPPER_PREDECESSOR = Symbol('errorcore.sdkWrapperPredecessor');

type WrappedTarget = Record<string | symbol, unknown> & {
  [OWNED_METHODS]?: Map<string, Function>;
};

type Wrapper = (original: Function) => Function;

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
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

type DriverName = 'pg' | 'mysql2' | 'ioredis' | 'mongodb';

type DriverResolution =
  | { driver: unknown }
  | { state: RecorderState };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasPrototypeMethod(value: unknown, methodName: string): boolean {
  return typeof (value as { prototype?: Record<string, unknown> } | undefined)
    ?.prototype?.[methodName] === 'function';
}

function isLikelyDriverModule(name: DriverName, value: unknown): boolean {
  if (name === 'ioredis') {
    return hasPrototypeMethod(value, 'sendCommand');
  }

  if (!isRecord(value)) {
    return false;
  }

  if (name === 'pg') {
    const client = value.Client;
    const pool = value.Pool;
    return (
      hasPrototypeMethod(client, 'query') ||
      hasPrototypeMethod(pool, 'query')
    );
  }

  if (name === 'mysql2') {
    return hasPrototypeMethod(value.Connection, 'query') ||
      hasPrototypeMethod(value.Connection, 'execute');
  }

  return hasPrototypeMethod(value.Collection, 'find');
}

function isModuleNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'MODULE_NOT_FOUND';
}

function resolveDriverSpecifier(
  name: DriverName,
  specifier: unknown
): DriverResolution {
  if (specifier === undefined) {
    return { driver: undefined };
  }

  if (typeof specifier === 'string') {
    try {
      return { driver: appRequire(specifier) };
    } catch (error) {
      return {
        state: {
          state: 'skip',
          reason: isModuleNotFound(error) ? 'not-installed' : 'resolve-failed'
        }
      };
    }
  }

  if (
    typeof specifier === 'function' &&
    !isLikelyDriverModule(name, specifier)
  ) {
    try {
      const resolved = (specifier as () => unknown)();
      if (
        typeof resolved === 'object' &&
        resolved !== null &&
        typeof (resolved as PromiseLike<unknown>).then === 'function'
      ) {
        return { state: { state: 'skip', reason: 'resolver-returned-promise' } };
      }
      return { driver: resolved };
    } catch (error) {
      return {
        state: {
          state: 'skip',
          reason: isModuleNotFound(error) ? 'not-installed' : 'resolver-failed'
        }
      };
    }
  }

  return { driver: specifier };
}

function skippedInstall(state: RecorderState): { uninstall: () => void; state: RecorderState } {
  return {
    uninstall: () => undefined,
    state
  };
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
    const pgDriver = resolveDriverSpecifier('pg', drivers.pg);
    const mysql2Driver = resolveDriverSpecifier('mysql2', drivers.mysql2);
    const ioredisDriver = resolveDriverSpecifier('ioredis', drivers.ioredis);
    const mongodbDriver = resolveDriverSpecifier('mongodb', drivers.mongodb);
    const pg = 'state' in pgDriver
      ? skippedInstall(pgDriver.state)
      : installPgPatch({ ...this.deps, explicitDriver: pgDriver.driver });
    const mysql2 = 'state' in mysql2Driver
      ? skippedInstall(mysql2Driver.state)
      : installMysql2Patch({ ...this.deps, explicitDriver: mysql2Driver.driver });
    const ioredis = 'state' in ioredisDriver
      ? skippedInstall(ioredisDriver.state)
      : installIoredisPatch({ ...this.deps, explicitDriver: ioredisDriver.driver });
    const mongodb = 'state' in mongodbDriver
      ? skippedInstall(mongodbDriver.state)
      : installMongodbPatch({ ...this.deps, explicitDriver: mongodbDriver.driver });
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
