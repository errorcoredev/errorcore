
import { TIGHT_LIMITS, cloneAndLimit } from '../serialization/clone-and-limit';
import { EventClock } from '../context/event-clock';
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

  private readonly eventClock: EventClock;

  private trackingEnabled = false;

  public constructor(deps: { als: ALSManagerLike; eventClock?: EventClock }) {
    this.als = deps.als;
    // EventClock is optional for test ergonomics; the SDK composition root
    // always passes one shared instance (module 19 contract).
    this.eventClock = deps.eventClock ?? new EventClock();
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
            this.safeRecordStateRead(name, 'get', key, value);
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
            this.safeRecordStateRead(name, 'has', key, value);
            return value;
          };
        }

        if (property === 'entries') {
          const original = Reflect.get(target, property, target) as Map<
            unknown,
            unknown
          >['entries'];

          return () => {
            this.safeRecordStateRead(name, 'entries', null, this.safeArrayFromEntries(target));
            return original.call(target);
          };
        }

        if (property === 'values') {
          const original = Reflect.get(target, property, target) as Map<
            unknown,
            unknown
          >['values'];

          return () => {
            this.safeRecordStateRead(name, 'values', null, this.safeArrayFromValues(target));
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
            this.safeRecordStateRead(name, 'forEach', null, this.safeArrayFromEntries(target));
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
        // Reflect.get can throw for getters defined on the target. That is
        // host-application behavior and must propagate. The recorder
        // side-effect runs after the value is obtained and is wrapped below
        // so a throwing recorder never masks or replaces that host behavior.
        const value = Reflect.get(target, property, receiver);

        if (
          typeof property === 'symbol' ||
          INTERNAL_OBJECT_PROPERTIES.has(property)
        ) {
          return value;
        }

        this.safeRecordStateRead(name, 'get', property, value);
        return value;
      }
    });
  }

  private safeArrayFromEntries(target: Map<unknown, unknown>): unknown {
    try {
      return Array.from(target.entries());
    } catch {
      return null;
    }
  }

  private safeArrayFromValues(target: Map<unknown, unknown>): unknown {
    try {
      return Array.from(target.values());
    } catch {
      return null;
    }
  }

  /**
   * Wrap recordStateRead so that any exception inside the recorder
   * (cloneAndLimit on a hostile value, ALS misbehavior, etc.) never
   * propagates out of the proxy trap. The host's read of the tracked
   * container must succeed even if telemetry fails.
   */
  private safeRecordStateRead(
    container: string,
    operation: string,
    key: unknown,
    value: unknown
  ): void {
    try {
      this.recordStateRead(container, operation, key, value);
    } catch {
      // Intentional swallow: telemetry failure must not affect host reads.
    }
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
      seq: this.eventClock.tick(),
      container,
      operation,
      key: cloneAndLimit(key, TIGHT_LIMITS),
      value: cloneAndLimit(value, TIGHT_LIMITS),
      timestamp: process.hrtime.bigint()
    };

    context.stateReads.push(stateRead);
  }
}
