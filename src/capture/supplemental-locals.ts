import type { CapturedFrame } from '../types';

export const ERRORCORE_SUPPLEMENTAL_LOCALS_SYMBOL = Symbol.for(
  'errorcore.v1.supplementalLocals'
);

export function attachSupplementalLocals(error: Error, frames: CapturedFrame[]): void {
  if (frames.length === 0) {
    return;
  }

  const target = error as unknown as Record<symbol, unknown>;
  const existing = target[ERRORCORE_SUPPLEMENTAL_LOCALS_SYMBOL];
  const nextFrames = Array.isArray(existing)
    ? [...(existing as CapturedFrame[]), ...frames]
    : frames;

  try {
    Object.defineProperty(error, ERRORCORE_SUPPLEMENTAL_LOCALS_SYMBOL, {
      value: nextFrames,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch {
    // Supplemental locals are best-effort; never affect user error flow.
  }
}

export function getSupplementalLocals(error: Error): CapturedFrame[] {
  const value = (error as unknown as Record<symbol, unknown>)[
    ERRORCORE_SUPPLEMENTAL_LOCALS_SYMBOL
  ];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((frame): frame is CapturedFrame => {
    return (
      typeof frame === 'object' &&
      frame !== null &&
      typeof frame.functionName === 'string' &&
      typeof frame.locals === 'object' &&
      frame.locals !== null
    );
  });
}

export function mergeSupplementalLocals(
  frames: CapturedFrame[] | null,
  supplemental: CapturedFrame[],
  maxFrames: number
): CapturedFrame[] | null {
  if (supplemental.length === 0) {
    return frames;
  }

  if (frames === null || frames.length === 0) {
    return supplemental.slice(0, maxFrames);
  }

  const mergedLocals: Record<string, unknown> = { ...frames[0].locals };
  for (const frame of supplemental) {
    for (const [key, value] of Object.entries(frame.locals)) {
      if (!(key in mergedLocals)) {
        mergedLocals[key] = value;
      }
    }
  }

  return [
    {
      ...frames[0],
      locals: mergedLocals
    },
    ...frames.slice(1, maxFrames)
  ];
}
