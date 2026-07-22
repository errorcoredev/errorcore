import { Scrubber, scrubKeyValueAssignments } from '../pii/scrubber';
import type { ResolvedConfig } from '../types';

const MAX_NON_ERROR_PREVIEW_LENGTH = 120;

export class NonErrorThrown extends Error {
  public readonly thrownType: string;

  public readonly thrownValue: unknown;

  public constructor(thrownType: string, thrownValue: unknown) {
    super(buildNonErrorThrownMessage(thrownType, thrownValue));
    this.name = 'NonErrorThrown';
    this.thrownType = thrownType;
    this.thrownValue = thrownValue;
  }
}

export function describeThrownType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

export function scrubThrownValue(value: unknown, config: ResolvedConfig): unknown {
  const scrubber = new Scrubber(config);
  const scrubInput = typeof value === 'string' ? scrubKeyValueAssignments(value) : value;
  return scrubber.scrubValue('thrownValue', scrubInput);
}

function truncatePreview(value: string): string {
  if (value.length <= MAX_NON_ERROR_PREVIEW_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_NON_ERROR_PREVIEW_LENGTH)}...`;
}

function previewForThrownValue(thrownType: string, thrownValue: unknown): string | null {
  if (thrownType === 'string') {
    return JSON.stringify(truncatePreview(String(thrownValue)));
  }

  if (
    thrownType === 'number' ||
    thrownType === 'boolean' ||
    thrownType === 'bigint' ||
    thrownType === 'symbol'
  ) {
    try {
      return truncatePreview(String(thrownValue));
    } catch {
      return null;
    }
  }

  return null;
}

export function buildNonErrorThrownMessage(
  thrownType: string,
  thrownValue: unknown
): string {
  const preview = previewForThrownValue(thrownType, thrownValue);
  return preview === null
    ? `Non-Error thrown (${thrownType})`
    : `Non-Error thrown (${thrownType}): ${preview}`;
}

export function buildNonErrorThrownInfo(
  value: unknown,
  config: ResolvedConfig
): { thrownType: string; thrownValue: unknown; message: string } {
  const thrownType = describeThrownType(value);
  const thrownValue = scrubThrownValue(value, config);
  return {
    thrownType,
    thrownValue,
    message: buildNonErrorThrownMessage(thrownType, thrownValue)
  };
}

export function normalizeThrown(value: unknown, config: ResolvedConfig): Error {
  if (value instanceof Error) {
    return value;
  }

  const { thrownType, thrownValue } = buildNonErrorThrownInfo(value, config);
  return new NonErrorThrown(thrownType, thrownValue);
}
