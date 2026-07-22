
export interface ParsedFrame {
  raw: string;
  functionName: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  isNodeModules: boolean;
}

export interface ParsedStack {
  errorLine: string;
  origin: ParsedFrame | null;
  frames: ParsedFrame[];
}

export type CollapsedEntry = ParsedFrame | { collapsed: number };

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?((?:[A-Za-z]:)?[^:]+):(\d+):(\d+)\)?$/;

function isVendorPath(filePath: string): boolean {
  return filePath.includes('node_modules') || filePath.startsWith('node:');
}

export function parseStack(stack: string): ParsedStack {
  const lines = stack.split('\n');
  let errorLine = '';
  const frames: ParsedFrame[] = [];
  let origin: ParsedFrame | null = null;

  for (const line of lines) {
    const match = line.match(FRAME_RE);
    if (match === null) {
      if (frames.length === 0 && errorLine === '') {
        errorLine = line.trim();
      }
      continue;
    }

    const frame: ParsedFrame = {
      raw: line.trimStart(),
      functionName: match[1] ?? '<anonymous>',
      filePath: match[2],
      lineNumber: parseInt(match[3], 10),
      columnNumber: parseInt(match[4], 10),
      isNodeModules: isVendorPath(match[2]),
    };

    frames.push(frame);

    if (origin === null && !frame.isNodeModules) {
      origin = frame;
    }
  }

  return { errorLine, origin, frames };
}

export function collapseNodeModulesFrames(frames: ParsedFrame[]): CollapsedEntry[] {
  const result: CollapsedEntry[] = [];
  let vendorCount = 0;

  for (const frame of frames) {
    if (frame.isNodeModules) {
      vendorCount++;
    } else {
      if (vendorCount > 0) {
        result.push({ collapsed: vendorCount });
        vendorCount = 0;
      }
      result.push(frame);
    }
  }

  if (vendorCount > 0) {
    result.push({ collapsed: vendorCount });
  }

  return result;
}
