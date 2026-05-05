
export const EMAIL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export const CREDIT_CARD_REGEX = /\b\d{13,19}\b/g;

export const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

export const JWT_REGEX =
  /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;

export const BEARER_REGEX = /\bBearer\s+[a-zA-Z0-9_\-.~+/]+=*\b/gi;

export const BASIC_AUTH_REGEX = /\bBasic\s+[A-Za-z0-9+/]+=*\b/gi;

export const AWS_ACCESS_KEY_REGEX = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

export const GITHUB_TOKEN_REGEX =
  /\b(?:ghp|gho)_[A-Za-z0-9]{20,255}\b|github_pat_[A-Za-z0-9_]{20,255}\b/g;

export const STRIPE_KEY_REGEX = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g;

export const GENERIC_SK_KEY_REGEX = /\bsk-[A-Za-z0-9]{10,}\b/g;

export const PHONE_REGEX =
  /(?:\+\d{1,3}[\s().-]*\d(?:[\s().-]*\d){7,9}|\(\d{2,4}\)[\s().-]*\d(?:[\s().-]*\d){5,7}|\b\d{3}[\s().-]\d{3}[\s().-]\d{4,}\b)/g;

export const IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export const COMBINED_QUICK_TEST_REGEX = new RegExp(
  [
    EMAIL_REGEX.source,
    SSN_REGEX.source,
    JWT_REGEX.source,
    BEARER_REGEX.source,
    BASIC_AUTH_REGEX.source,
    AWS_ACCESS_KEY_REGEX.source,
    GITHUB_TOKEN_REGEX.source,
    STRIPE_KEY_REGEX.source,
    GENERIC_SK_KEY_REGEX.source,
    PHONE_REGEX.source,
    IPV4_REGEX.source,
    CREDIT_CARD_REGEX.source
  ].join('|'),
  'gi'
);

export const SENSITIVE_KEY_EXACT_MATCHES = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'key',
  'auth',
  'credential',
  'ssn',
  'cvv',
  'cvc',
  'phone',
  'session',
  'cookie',
  'oauth',
  'private'
]);

export const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'key',
  'auth',
  'credential',
  'ssn',
  'cvv',
  'cvc',
  'expir',
  'phone',
  'session',
  'cookie',
  'oauth',
  'private'
] as const;

export const SENSITIVE_KEY_COMPLEX_REGEX =
  /social.*security|credit.*card|card.*number/i;

export const SENSITIVE_KEY_REGEX =
  /(^|[-_.])(passwords?|passwd|secrets?|tokens?|keys?|auth|credentials?|ssn|cvv|cvc|expir(?:y|ation)?|phone|session|cookie|oauth|private)([-_.]|$)|social.*security|credit.*card|card.*number/i;

export function isValidLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble && (digit *= 2) > 9) digit -= 9;
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}
