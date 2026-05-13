import type { StackBoundaryFrame, StackOwnershipMetadata } from '../types';

const V8_STACK_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

export type FrameOwnershipKind = 'app' | 'external';

export interface ParsedStackFrame {
  functionName: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
}

export function normalizeFramePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function classifyFramePath(filePath: string): FrameOwnershipKind {
  const normalized = normalizeFramePath(filePath);
  return normalized.startsWith('node:') ||
    normalized.includes('node:internal') ||
    normalized.includes('/node_modules/')
    ? 'external'
    : 'app';
}

export function extractNodeModulesPackageName(filePath: string): string | undefined {
  const normalized = normalizeFramePath(filePath);
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const rest = normalized.slice(markerIndex + marker.length);
  const parts = rest.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }

  if (parts[0]!.startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

export function parseStackFrames(stack: string | undefined): ParsedStackFrame[] {
  if (stack === undefined || stack === '') {
    return [];
  }

  const frames: ParsedStackFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = V8_STACK_FRAME_RE.exec(line);
    if (match === null) {
      continue;
    }

    frames.push({
      functionName: match[1]?.trim() ?? '<anonymous>',
      filePath: match[2]!,
      lineNumber: Number.parseInt(match[3]!, 10),
      columnNumber: Number.parseInt(match[4]!, 10)
    });
  }

  return frames;
}

function toBoundaryFrame(frame: ParsedStackFrame): StackBoundaryFrame {
  return {
    functionName: frame.functionName,
    filePath: frame.filePath,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber
  };
}

export function analyzeStackOwnership(
  stack: string | undefined,
  errorType = 'Error'
): StackOwnershipMetadata {
  const frames = parseStackFrames(stack);
  const firstFrame = frames[0];
  const firstExternalFrame = frames.find(
    (frame) => classifyFramePath(frame.filePath) === 'external'
  );
  const firstAppFrame = frames.find((frame) => classifyFramePath(frame.filePath) === 'app');
  const appFrameCount = frames.reduce(
    (count, frame) => count + Number(classifyFramePath(frame.filePath) === 'app'),
    0
  );
  const externalFrameCount = frames.length - appFrameCount;
  const packageName =
    firstExternalFrame === undefined
      ? undefined
      : extractNodeModulesPackageName(firstExternalFrame.filePath);

  return {
    origin:
      firstFrame !== undefined && classifyFramePath(firstFrame.filePath) === 'external'
        ? 'external'
        : 'app',
    ...(packageName === undefined ? {} : { package: packageName }),
    errorType,
    ...(firstAppFrame === undefined ? {} : { appBoundaryFrame: toBoundaryFrame(firstAppFrame) }),
    externalFramesCollapsed: externalFrameCount > 0,
    externalFrameCount,
    appFrameCount
  };
}
