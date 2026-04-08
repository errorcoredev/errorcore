
import { TIGHT_LIMITS, cloneAndLimit } from '../serialization/clone-and-limit';
import type { RequestContext, StateRead } from '../types';

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
}

const INTERNAL_OBJECT_PROPERTIES = new Set<string>([
  'constructor',
  '__proto__',
  'prototype',
  'toJSON',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable'
]);
const MAX_STATE_READS_PER_CONTEXT = 50;

export class StateTracker {
  private readonly als: ALSManagerLike;

  private trackingEnabled = false;

  public constructor(deps: { als: ALSManagerLike }) {
    this.als = deps.als;
  }

  public track<T extends Map<unknown, unknown> | Record<string, unknown>>(
    name: string,
    container: T
  ): T {
    this.trackingEnabled = true;

    if (container instanceof Map) {
      return this.createMapProxy(name, container) as T;
    }

    return this.createObjectProxy(name, container) as T;
  }

  public isTrackingEnabled(): boolean {
    return this.trackingEnabled;
  }

  private createMapProxy(
    name: string,
    container: Map<unknown, unknown>
  ): Map<unknown, unknown> {
    return new Proxy(container, {
      get: (target, property) => {
        if (property === 'get') {
          const original = Reflect.get(target, property, target) as Map<
            unknown,
            unknown
          >['get'];

          return (key: unknown) => {
            const value = original.call(target, key);
            this.recordStateRead(name, 'get', key, value);
            return value;
          };
        }

        if (property === 'has') {
          const original = Reflect.get(target, property, target) as Map<
            unknown,
            unknown
          >['has'];

          return (key: unknown) => {
            const value = original.call(target, key);
            this.recordStateRead(name, 'has', key, value);
            return value;
          };
        }

        if (property === 'entries') {
          const original = Reflect.get(target, property, target) as Map<
            unknown,
            unknown
          >['entries'];

          return () => {
            this.recordStateRead(name, 'entries', null, Array.from(target.entries()));
            return original.call(target);
          };
        }

        if (property === 'values') {
          const original = Reflect.get(target, property, target) as Map<
            unknown,
            unknown
          >['values'];

          return () => {
            this.recordStateRead(name, 'values', null, Array.from(target.values()));
            return original.call(target);
          };
        }

        if (property === 'forEach') {
          const original = Reflect.get(target, property, target) as Map<
            unknown,
            unknown
          >['forEach'];

          return (
            callback: (
              value: unknown,
              key: unknown,
              map: Map<unknown, unknown>
            ) => void,
            thisArg?: unknown
          ) => {
            this.recordStateRead(name, 'forEach', null, Array.from(target.entries()));
            return original.call(target, callback, thisArg);
          };
        }

        const value = Reflect.get(target, property, target);

        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  private createObjectProxy(
    name: string,
    container: Record<string, unknown>
  ): Record<string, unknown> {
    return new Proxy(container, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);

        if (
          typeof property === 'symbol' ||
          INTERNAL_OBJECT_PROPERTIES.has(property)
        ) {
          return value;
        }

        this.recordStateRead(name, 'get', property, value);
        return value;
      }
    });
  }

  private recordStateRead(
    container: string,
    operation: string,
    key: unknown,
    value: unknown
  ): void {
    const context = this.als.getContext();

    if (context === undefined) {
      return;
    }

    if (context.stateReads.length >= MAX_STATE_READS_PER_CONTEXT) {
      return;
    }

    const stateRead: StateRead = {
      container,
      operation,
      key: cloneAndLimit(key, TIGHT_LIMITS),
      value: cloneAndLimit(value, TIGHT_LIMITS),
      timestamp: process.hrtime.bigint()
    };

    context.stateReads.push(stateRead);
  }
}
