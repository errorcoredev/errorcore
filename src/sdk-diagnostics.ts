export type BundlerKind = 'webpack' | 'unknown';

export function detectBundler(): BundlerKind {
  if (typeof (globalThis as Record<string, unknown>).__webpack_require__ !== 'undefined') {
    return 'webpack';
  }
  return 'unknown';
}

export function isNextJsNodeRuntime(): boolean {
  return process.env.NEXT_RUNTIME === 'nodejs';
}

export type RecorderState =
  | { state: 'ok' }
  | { state: 'skip'; reason: string }
  | { state: 'warn'; reason: string };

export function classifyRecorderStatus(input: {
  installed: boolean;
  reason?: string;
}): RecorderState {
  if (input.installed) return { state: 'ok' };
  const reason = input.reason ?? 'unknown';
  if (reason === 'bundled-unpatched') return { state: 'warn', reason };
  return { state: 'skip', reason };
}

export function formatStartupLine(input: {
  version: string;
  nodeVersion: string;
  recorders: Record<string, RecorderState>;
}): string {
  const parts = Object.entries(input.recorders)
    .map(([name, s]) => {
      if (s.state === 'ok') return `${name}=ok`;
      return `${name}=${s.state}(${s.reason})`;
    })
    .join(' ');
  return `[errorcore] ${input.version} node=${input.nodeVersion} recorders: ${parts}`;
}

export function formatWarnGuidance(
  name: string,
  state: RecorderState,
  context: { isNextJs: boolean }
): string | null {
  if (state.state !== 'warn') return null;
  if (state.reason === 'bundled-unpatched') {
    if (context.isNextJs) {
      return `[errorcore]   → ${name}: driver present but bundled. Add '${name}' to serverExternalPackages in next.config.js.`;
    }
    return `[errorcore]   → ${name}: driver present but bundled. Pass drivers: { ${name}: require('${name}') } to errorcore.init().`;
  }
  return `[errorcore]   → ${name}: ${state.reason}`;
}
