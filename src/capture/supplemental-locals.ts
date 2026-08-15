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
  const normalizedSupplemental = supplemental.map((frame, index) => ({
    ...frame,
    frameId: frame.frameId ??
      `supplemental:${frame.functionName}:${frame.filePath}:${frame.lineNumber}:${frame.columnNumber}:${index}`,
    causeOrigin: frame.causeOrigin ?? { kind: 'error' as const, depth: 0 },
    scopes: frame.scopes ?? [{
      type: 'local' as const,
      bindings: Object.entries(frame.locals).map(([name, value]) => ({
        name,
        captured: {
          value,
          status: 'captured' as const,
          captureSource: 'supplemental_instrumentation' as const,
          origin: 'supplemental_local' as const,
          correlationQuality: 'unmatched' as const,
          causeOrigin: { kind: 'error' as const, depth: 0 }
        }
      })),
      truncated: false,
      omittedBindings: 0
    }]
  }));

  if (supplemental.length === 0) {
    return frames;
  }

  if (frames === null || frames.length === 0) {
    return normalizedSupplemental.slice(0, maxFrames);
  }

  const mergedLocals: Record<string, unknown> = { ...frames[0].locals };
  for (const frame of normalizedSupplemental) {
    for (const [key, value] of Object.entries(frame.locals)) {
      if (!(key in mergedLocals)) {
        mergedLocals[key] = value;
      }
    }
  }

  return [
    {
      ...frames[0],
      locals: mergedLocals,
      scopes: [
        ...(frames[0].scopes ?? []),
        ...normalizedSupplemental.flatMap((frame) => frame.scopes ?? [])
      ]
    },
    ...frames.slice(1, maxFrames)
  ];
}
