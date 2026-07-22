import {
  CREDIT_CARD_REGEX,
  EMAIL_REGEX,
  PHONE_REGEX,
  isValidLuhn
} from '../pii/patterns';
import type { Policy } from './types';

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function isEmail(value: unknown): boolean {
  return typeof value === 'string' && matches(EMAIL_REGEX, value);
}

export function isPhone(value: unknown): boolean {
  return typeof value === 'string' && matches(PHONE_REGEX, value);
}

export function isCreditCard(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  CREDIT_CARD_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREDIT_CARD_REGEX.exec(value)) !== null) {
    if (isValidLuhn(match[0])) {
      return true;
    }
  }
  return false;
}

export const defaultPolicy: Policy = {
  credentialNames: /password|secret|token|api[_-]?key|auth|cookie|bearer/i,
  piiDetectors: [isEmail, isPhone, isCreditCard],
  maxKeys: 32,
  spoolBytes: 65_536,
  maxField: 1_048_576
};

export function resolveScrubberPolicy(input: Partial<Policy> = {}): Policy {
  return {
    credentialNames: input.credentialNames ?? defaultPolicy.credentialNames,
    piiDetectors: input.piiDetectors ?? defaultPolicy.piiDetectors,
    maxKeys: input.maxKeys ?? defaultPolicy.maxKeys,
    spoolBytes: input.spoolBytes ?? defaultPolicy.spoolBytes,
    maxField: input.maxField ?? defaultPolicy.maxField
  };
}
