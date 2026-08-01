
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Threshold (in bytes) above which `maybeCompress` will deflate the
 * plaintext before encryption. Below the threshold the cost of zlib
 * dwarfs the savings; the headers and dictionary overhead actually
 * inflate small payloads.
 */
export const COMPRESSION_THRESHOLD_BYTES = 8192;

export interface MaybeCompressResult {
  buf: Buffer;
  compressed: boolean;
}

/**
 * Deflate plaintext when it exceeds COMPRESSION_THRESHOLD_BYTES. Uses
 * raw deflate (no zlib header / Adler-32 trailer) to minimize overhead;
 * the envelope's `compressed` flag and the AAD identify the format so
 * the receiver knows when to inflate.
 *
 * Always returns a Buffer; pass through unchanged when below threshold.
 */
export function maybeCompress(plaintext: Buffer): MaybeCompressResult {
  if (plaintext.length <= COMPRESSION_THRESHOLD_BYTES) {
    return { buf: plaintext, compressed: false };
  }

  const compressed = deflateRawSync(plaintext);
  // If compression actually inflated the payload (random or already-
  // compressed input), fall back to the original. Saves the receiver
  // from wasted inflate work and keeps the wire smaller.
  if (compressed.length >= plaintext.length) {
    return { buf: plaintext, compressed: false };
  }

  return { buf: compressed, compressed: true };
}

/**
 * Default hard cap on decompressed plaintext (10 MiB). Callers can lower
 * or raise it, but there is no unbounded path: a deflate bomb must throw
 * during inflation instead of allocating an arbitrarily large buffer.
 */
export const DEFAULT_MAX_PLAINTEXT_BYTES = 10 * 1024 * 1024;

/**
 * Inverse of maybeCompress. `compressed` is read from the envelope.
 * `maxOutputLength` bounds the inflated size DURING inflation (zlib
 * aborts as soon as the output would exceed the cap); breaching it
 * throws EC_DECOMPRESSION_LIMIT_EXCEEDED, any other inflate failure
 * throws EC_DECOMPRESSION_FAILED.
 */
export function maybeDecompress(
  buf: Buffer,
  compressed: boolean,
  maxOutputLength: number = DEFAULT_MAX_PLAINTEXT_BYTES
): Buffer {
  if (!compressed) {
    return buf;
  }

  try {
    return inflateRawSync(buf, { maxOutputLength });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `EC_DECOMPRESSION_LIMIT_EXCEEDED: inflated payload exceeds ${maxOutputLength} bytes`
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`EC_DECOMPRESSION_FAILED: ${reason}`);
  }
}
