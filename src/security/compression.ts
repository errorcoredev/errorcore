
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
 * Inverse of maybeCompress. `compressed` is read from the envelope.
 */
export function maybeDecompress(buf: Buffer, compressed: boolean): Buffer {
  if (!compressed) {
    return buf;
  }

  return inflateRawSync(buf);
}
