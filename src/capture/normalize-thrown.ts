import { Scrubber, scrubKeyValueAssignments } from '../pii/scrubber';
import type { ResolvedConfig } from '../types';

export class NonErrorThrown extends Error {
  public readonly thrownType: string;

  public readonly thrownValue: unknown;

  public constructor(thrownType: string, thrownValue: unknown) {
    super(`Non-Error thrown (${thrownType})`);
    this.name = 'NonErrorThrown';
    this.thrownType = thrownType;
    this.thrownValue = thrownValue;
  }
}

function describeThrownType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

function scrubThrownValue(value: unknown, config: ResolvedConfig): unknown {
  const scrubber = new Scrubber(config);
  const scrubInput = typeof value === 'string' ? scrubKeyValueAssignments(value) : value;
  return scrubber.scrubValue('thrownValue', scrubInput);
}

export function normalizeThrown(value: unknown, config: ResolvedConfig): Error {
  if (value instanceof Error) {
    return value;
  }

  const thrownType = describeThrownType(value);
  return new NonErrorThrown(thrownType, scrubThrownValue(value, config));
}
