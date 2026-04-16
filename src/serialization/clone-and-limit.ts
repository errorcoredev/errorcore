
import type { SerializationLimits } from '../types';

export const STANDARD_LIMITS: SerializationLimits = {
  maxDepth: 8,
  maxArrayItems: 20,
  maxObjectKeys: 50,
  maxStringLength: 2048,
  maxPayloadSize: 32768,
  maxTotalPackageSize: 5242880
};

export const TIGHT_LIMITS: SerializationLimits = {
  maxDepth: 4,
  maxArrayItems: 10,
  maxObjectKeys: 20,
  maxStringLength: 512,
  maxPayloadSize: 32768,
  maxTotalPackageSize: 5242880
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }

  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

function truncateString(value: string, maxStringLength: number): string {
  if (value.length <= maxStringLength) {
    return value;
  }

  return `${value.slice(0, maxStringLength)}...[truncated, ${value.length} chars]`;
}

function cloneMap(
  value: Map<unknown, unknown>,
  limits: SerializationLimits,
  currentDepth: number,
  visited: Set<object>,
  budget: CloneBudget
): { _type: 'Map'; size: number; entries: unknown[][] } {
  const entries: unknown[][] = [];
  let index = 0;

  for (const [key, entryValue] of value.entries()) {
    if (index >= limits.maxArrayItems || budget.remaining <= 0) {
      break;
    }

    entries.push([
      cloneAndLimitInternal(key, limits, currentDepth + 1, visited, budget),
      cloneAndLimitInternal(entryValue, limits, currentDepth + 1, visited, budget)
    ]);
    index += 1;
  }

  return {
    _type: 'Map',
    size: value.size,
    entries
  };
}

function cloneSet(
  value: Set<unknown>,
  limits: SerializationLimits,
  currentDepth: number,
  visited: Set<object>,
  budget: CloneBudget
): { _type: 'Set'; size: number; values: unknown[] } {
  const values: unknown[] = [];
  let index = 0;

  for (const entryValue of value.values()) {
    if (index >= limits.maxArrayItems || budget.remaining <= 0) {
      break;
    }

    values.push(cloneAndLimitInternal(entryValue, limits, currentDepth + 1, visited, budget));
    index += 1;
  }

  return {
    _type: 'Set',
    size: value.size,
    values
  };
}

function cloneTypedArray(
  value: ArrayBufferView & { length: number; [index: number]: number },
  limits: SerializationLimits
): { _type: string; length: number; sample: number[] } {
  const sample: number[] = [];

  for (
    let index = 0;
    index < value.length && index < limits.maxArrayItems;
    index += 1
  ) {
    sample.push(value[index]);
  }

  return {
    _type: value.constructor.name,
    length: value.length,
    sample
  };
}

function cloneArray(
  value: unknown[],
  limits: SerializationLimits,
  currentDepth: number,
  visited: Set<object>,
  budget: CloneBudget
): unknown {
  const itemCount = Math.min(value.length, limits.maxArrayItems);
  const clonedItems = new Array<unknown>(itemCount);

  for (let index = 0; index < itemCount; index += 1) {
    if (budget.remaining <= 0) {
      clonedItems[index] = '[Payload size limit]';
      continue;
    }
    try {
      clonedItems[index] = cloneAndLimitInternal(
        value[index],
        limits,
        currentDepth + 1,
        visited,
        budget
      );
    } catch (error) {
      clonedItems[index] = `[Serialization error: ${getErrorMessage(error)}]`;
    }
  }

  if (value.length <= limits.maxArrayItems) {
    return clonedItems;
  }

  return {
    _items: clonedItems,
    _truncated: true,
    _originalLength: value.length
  };
}

function cloneObject(
  value: object,
  limits: SerializationLimits,
  currentDepth: number,
  visited: Set<object>,
  budget: CloneBudget
): Record<string, unknown> {
  const keys = Object.keys(value);
  const keyCount = Math.min(keys.length, limits.maxObjectKeys);
  const cloned: Record<string, unknown> = {};

  for (let index = 0; index < keyCount; index += 1) {
    if (budget.remaining <= 0) {
      cloned._truncated = true;
      cloned._originalKeyCount = keys.length;
      break;
    }

    const key = keys[index];
    budget.remaining -= key.length;

    try {
      cloned[key] = cloneAndLimitInternal(
        (value as Record<string, unknown>)[key],
        limits,
        currentDepth + 1,
        visited,
        budget
      );
    } catch (error) {
      cloned[key] = `[Serialization error: ${getErrorMessage(error)}]`;
    }
  }

  if (keys.length > limits.maxObjectKeys) {
    cloned._truncated = true;
    cloned._originalKeyCount = keys.length;
  }

  return cloned;
}

interface CloneBudget {
  remaining: number;
}

export function cloneAndLimit(
  value: unknown,
  limits: SerializationLimits,
  currentDepth?: number,
  visited?: Set<object>
): unknown {
  const budget: CloneBudget = { remaining: limits.maxPayloadSize };
  return cloneAndLimitInternal(value, limits, currentDepth ?? 0, visited ?? new Set<object>(), budget);
}

function cloneAndLimitInternal(
  value: unknown,
  limits: SerializationLimits,
  currentDepth: number,
  visited: Set<object>,
  budget: CloneBudget
): unknown {
  try {
    if (budget.remaining <= 0) {
      return '[Payload size limit]';
    }

    if (currentDepth > limits.maxDepth) {
      return '[Depth limit]';
    }

    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'bigint') {
      const str = value.toString();
      budget.remaining -= str.length + 20;
      return {
        _type: 'BigInt',
        value: str
      };
    }

    if (typeof value === 'string') {
      const result = truncateString(value, limits.maxStringLength);
      budget.remaining -= result.length;
      return result;
    }

    if (typeof value === 'symbol') {
      return `[Symbol: ${value.description ?? ''}]`;
    }

    if (typeof value === 'function') {
      return `[Function: ${value.name || 'anonymous'}]`;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof RegExp) {
      return {
        _type: 'RegExp',
        source: value.source,
        flags: value.flags
      };
    }

    if (value instanceof Error) {
      return {
        _type: 'Error',
        name: value.name,
        message: value.message,
        stack: value.stack ?? ''
      };
    }

    if (Buffer.isBuffer(value)) {
      return {
        _type: 'Buffer',
        encoding: 'base64',
        data: truncateString(value.toString('base64'), limits.maxStringLength),
        length: value.length
      };
    }

    if (value instanceof Map) {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);

      try {
        return cloneMap(value, limits, currentDepth, visited, budget);
      } finally {
        visited.delete(value);
      }
    }

    if (value instanceof Set) {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);

      try {
        return cloneSet(value, limits, currentDepth, visited, budget);
      } finally {
        visited.delete(value);
      }
    }

    if (
      ArrayBuffer.isView(value) &&
      !Buffer.isBuffer(value) &&
      !(value instanceof DataView)
    ) {
      return cloneTypedArray(
        value as ArrayBufferView & { length: number; [index: number]: number },
        limits
      );
    }

    if (value instanceof ArrayBuffer) {
      return {
        _type: 'ArrayBuffer',
        byteLength: value.byteLength
      };
    }

    if (Array.isArray(value)) {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);

      try {
        return cloneArray(value, limits, currentDepth, visited, budget);
      } finally {
        visited.delete(value);
      }
    }

    if (typeof value === 'object') {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);

      try {
        return cloneObject(value, limits, currentDepth, visited, budget);
      } finally {
        visited.delete(value);
      }
    }

    return null;
  } catch (error) {
    return `[Serialization error: ${getErrorMessage(error)}]`;
  }
}
