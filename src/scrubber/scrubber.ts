import type { Encryption } from '../security/encryption';
import { computeMeta, encodeNormal } from './encoder';
import type {
  Field,
  FieldMetadataOnlyReason,
  FieldSpool,
  FieldWarning,
  Policy,
  Source
} from './types';

interface ScrubberDeps {
  encryption?: Encryption | null;
  spool?: FieldSpool;
  onWarning?: (warning: FieldWarning) => void;
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export class Scrubber {
  private readonly policy: Policy;

  private readonly encryption: Encryption | null;

  private readonly spool: FieldSpool | undefined;

  private readonly onWarning: ((warning: FieldWarning) => void) | undefined;

  public constructor(policy: Policy, deps: ScrubberDeps = {}) {
    this.policy = policy;
    this.encryption = deps.encryption ?? null;
    this.spool = deps.spool;
    this.onWarning = deps.onWarning;
  }

  public process(name: string, value: unknown, source: Source): Field {
    const meta = computeMeta(value, this.policy.maxKeys);

    try {
      const sensitiveReason = this.sensitiveReason(name, value);
      if (sensitiveReason !== null) {
        return { schemaVersion: 2, mode: 'meta', meta, reason: sensitiveReason };
      }

      if (this.encryption === null) {
        this.emitWarning({
          code: 'EC_FIELD_ENCRYPTION_KEY_MISSING',
          message: 'Field encryption skipped because no encryption key is configured.',
          context: { name, source }
        });
        return { schemaVersion: 2, mode: 'meta', meta, reason: 'encryption_key_missing' };
      }

      return encodeNormal({
        name,
        value,
        meta,
        source,
        policy: this.policy,
        encryption: this.encryption,
        spool: this.spool
      });
    } catch (error) {
      this.emitWarning({
        code: 'EC_FIELD_ENCODE_FAILED',
        message: 'Field encoding failed; falling back to metadata-only capture.',
        cause: error,
        context: { name, source }
      });
      return { schemaVersion: 2, mode: 'meta', meta, reason: 'encode_failed' };
    }
  }

  public processRef(
    name: string,
    value: unknown,
    source: Source,
    ref: { id: string; bytes: number }
  ): Field {
    const meta = {
      ...computeMeta(value, this.policy.maxKeys),
      bytes: ref.bytes
    };

    try {
      const sensitiveReason = this.sensitiveReason(name, value);
      if (sensitiveReason !== null) {
        return { schemaVersion: 2, mode: 'meta', meta, reason: sensitiveReason };
      }

      if (this.encryption === null) {
        this.emitWarning({
          code: 'EC_FIELD_ENCRYPTION_KEY_MISSING',
          message: 'Field spool ref skipped because no encryption key is configured.',
          context: { name, source, refId: ref.id }
        });
        return { schemaVersion: 2, mode: 'meta', meta, reason: 'encryption_key_missing' };
      }

      return {
        schemaVersion: 2,
        mode: 'encrypted',
        meta,
        cipher: {
          type: 'ref',
          id: ref.id,
          bytes: ref.bytes
        }
      };
    } catch (error) {
      this.emitWarning({
        code: 'EC_FIELD_SPOOL_FAILED',
        message: 'Field spool ref encoding failed; falling back to metadata-only capture.',
        cause: error,
        context: { name, source, refId: ref.id }
      });
      return { schemaVersion: 2, mode: 'meta', meta, reason: 'spool_failed' };
    }
  }

  private sensitiveReason(name: string, value: unknown): FieldMetadataOnlyReason | null {
    try {
      if (matches(this.policy.credentialNames, name)) {
        return 'credential_name';
      }

      for (const detector of this.policy.piiDetectors) {
        if (detector(value)) {
          return 'pii_detector';
        }
      }
    } catch (error) {
      this.emitWarning({
        code: 'EC_FIELD_ENCODE_FAILED',
        message: 'Field sensitivity detection failed; treating field as sensitive.',
        cause: error,
        context: { name }
      });
      return 'sensitivity_check_failed';
    }

    return null;
  }

  private emitWarning(warning: FieldWarning): void {
    try {
      this.onWarning?.(warning);
    } catch {
    }
  }
}
