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

export type LegacyBlob =
  | { type: 'inline'; bytes: Uint8Array; nonce: Uint8Array }
  | { type: 'ref'; id: string; bytes: number };

export type FieldMetadataOnlyReason =
  | 'credential_name'
  | 'pii_detector'
  | 'encryption_key_missing'
  | 'spool_unavailable'
  | 'max_field_bytes'
  | 'sensitivity_check_failed'
  | 'encode_failed'
  | 'spool_failed';

export type CanonicalBlob =
  | { type: 'inline'; encoding: 'base64'; ciphertext: string; nonce: string }
  | { type: 'ref'; id: string; bytes: number };

export type LegacyField =
  | { mode: 'meta'; meta: Meta }
  | { mode: 'encrypted'; meta: Meta; cipher: LegacyBlob };

export type Field =
  | LegacyField
  | { schemaVersion: 2; mode: 'meta'; meta: Meta; reason: FieldMetadataOnlyReason }
  | { schemaVersion: 2; mode: 'encrypted'; meta: Meta; cipher: CanonicalBlob };

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
