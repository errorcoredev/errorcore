import type { InternalWarning } from '../types';

export type Tag = 'sensitive' | 'normal';
export type Mode = 'meta' | 'encrypted';
export type Source = 'http_incoming' | 'app';

export interface Meta {
  type: string;
  bytes: number;
  len?: number;
  keys?: string[];
}

export type Blob =
  | { type: 'inline'; bytes: Uint8Array; nonce: Uint8Array }
  | { type: 'ref'; id: string; bytes: number };

export type Field =
  | { mode: 'meta'; meta: Meta }
  | { mode: 'encrypted'; meta: Meta; cipher: Blob };

export interface Policy {
  credentialNames: RegExp;
  piiDetectors: Array<(value: unknown) => boolean>;
  maxKeys: number;
  spoolBytes: number;
  maxField: number;
}

export interface FieldSpoolStoreInput {
  bytes: Buffer;
  originalSize: number;
  name: string;
  source: Source;
}

export interface FieldSpool {
  store(input: FieldSpoolStoreInput): { id: string; bytes: number };
  get?(id: string): Buffer | null;
}

export type FieldWarning = Pick<InternalWarning, 'code' | 'message' | 'cause' | 'context'>;
