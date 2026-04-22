import { createHash } from 'node:crypto';
import type { CapturedFrame } from '../types';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DQUOTED_RE = /"[^"]*"/g;
const SQUOTED_RE = /'[^']*'/g;
const HEX_RE = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const NUM_RE = /\b\d+\b/g;

function normalizeMessage(msg: string): string {
  return msg
    .replace(UUID_RE, '<uuid>')
    .replace(DQUOTED_RE, '<str>')
    .replace(SQUOTED_RE, '<str>')
    .replace(HEX_RE, '<hex>')
    .replace(NUM_RE, '<num>');
}

function pickTopFrame(frames: CapturedFrame[]): CapturedFrame | null {
  if (frames.length === 0) return null;
  for (const f of frames) {
    const p = f.filePath || '';
    if (!p.includes('node:internal') && !p.includes('node_modules')) {
      return f;
    }
  }
  return frames[0] ?? null;
}

export function computeFingerprint(
  error: Error,
  stackFrames: CapturedFrame[]
): string {
  const constructorName = error.constructor?.name || 'Error';
  const frame = pickTopFrame(stackFrames);
  const frameKey = frame
    ? `${frame.filePath}:${frame.functionName}:${frame.lineNumber}`
    : 'unknown:unknown:0';
  const normalized = normalizeMessage(error.message || '');
  const input = `${constructorName}|${frameKey}|${normalized}`;
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}
