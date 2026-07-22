# Module 04: PII Scrubbing System

> **Spec status:** LOCKED
> **Source files:** `src/pii/patterns.ts`, `src/pii/scrubber.ts`, `src/pii/header-filter.ts`
> **Dependencies:** Module 01 (types, config), Module 02 (clone-and-limit)
> **Build order position:** 4

---

## Module Contract Header

```typescript
/**
 * @module 04-pii-scrubbing
 * @spec spec/04-pii-scrubbing.md
 * @dependencies types.ts, config.ts, clone-and-limit.ts
 */
```

---

## Purpose

Provide default-on PII detection and redaction for all data captured by the SDK: headers, request/response bodies, local variables, database parameters, environment variables, and file paths.

---

## Scope

- `patterns.ts`: Regex patterns and a Luhn validator for credit card detection
- `scrubber.ts`: Recursive object scrubber that redacts sensitive keys and values
- `header-filter.ts`: Header allowlist/blocklist filter
- File path scrubbing utility
- Database parameter scrubbing utility

---

## Non-Goals

- Does not perform encryption (module 05).
- Does not determine WHEN scrubbing happens (callers decide).
- Does not handle body parsing (bodies arrive as strings or parsed objects).

---

## Dependencies

- Module 01: `ResolvedConfig` (for allowlists/blocklists and custom scrubber function)
- Module 02: `cloneAndLimit` (scrubber creates a deep clone before mutating)

---

## Node.js APIs Used

- `require('node:os').homedir()` for file path scrubbing

---

## Data Structures

### patterns.ts exports

```typescript
const EMAIL_REGEX: RegExp;          // /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const CREDIT_CARD_REGEX: RegExp;    // /\b\d{13,19}\b/g
const SSN_REGEX: RegExp;            // /\b\d{3}-\d{2}-\d{4}\b/g
const JWT_REGEX: RegExp;            // /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g
const BEARER_REGEX: RegExp;         // /\bBearer\s+[a-zA-Z0-9_\-.~+/]+=*\b/gi
const SENSITIVE_KEY_REGEX: RegExp;  // /password|passwd|secret|token|key|auth|credential|ssn|social.*security|credit.*card|card.*number|cvv|cvc|expir/i
function isValidLuhn(digits: string): boolean;
```

### Scrubber class

```typescript
class Scrubber {
  constructor(config: ResolvedConfig);
  scrubObject(obj: object): object;     // deep-clone + scrub, returns new object
  scrubValue(key: string, value: unknown): unknown;
  scrubDbParams(params: unknown[]): string[];
  scrubFilePath(path: string): string;
  scrubEnv(env: Record<string, string>): Record<string, string>;
}
```

### HeaderFilter class

```typescript
class HeaderFilter {
  constructor(config: ResolvedConfig);
  filterHeaders(headers: Record<string, string>): Record<string, string>;
}
```

---

## Implementation Notes

### scrubValue logic

1. If `key` matches `SENSITIVE_KEY_REGEX` -> return `'[REDACTED]'`
2. If `value` is a string:
   - Replace email matches with `'[REDACTED]'`
   - Replace credit card matches (only if Luhn-valid) with `'[REDACTED]'`
   - Replace SSN matches with `'[REDACTED]'`
   - Replace JWT matches with `'[REDACTED]'`
   - Replace bearer token matches with `'[REDACTED]'`
3. If `value` is object/array: recursively scrub each key-value pair
4. Depth limit: 10 levels. Beyond that: `'[DEPTH_LIMIT]'`
5. Circular reference detection via `WeakSet`

### scrubObject

- Creates a deep clone via `cloneAndLimit` (standard limits) FIRST, then scrubs the clone. Never mutates the original.

### Custom scrubber

- If `config.piiScrubber` is provided and `config.replaceDefaultScrubber` is false: run default scrubber first, then pass result through custom scrubber.
- If `config.replaceDefaultScrubber` is true: skip default, use only custom scrubber.

### Luhn validator

Implement in < 20 lines. Validate digit strings of length 13-19. Used to reduce false positives on credit card regex matches.

### Header filtering

For each header in input:
1. Lowercase the header name
2. Check if it is in `config.headerAllowlist` (case-insensitive)
3. Check if it matches any `config.headerBlocklist` regex
4. If allowed AND not blocked: include in output
5. Blocklist always wins over allowlist

### File path scrubbing

Replace `os.homedir()` prefix with `/~/`. Example: `/home/john/app/src/handler.js` -> `/~/app/src/handler.js`

### Database parameter scrubbing

```typescript
scrubDbParams(params: unknown[]): string[]
  // Returns ['[PARAM_1]', '[PARAM_2]', ...] with same length as input
```

### Environment variable scrubbing

```typescript
scrubEnv(env: Record<string, string>): Record<string, string>
  // Include only keys in config.envAllowlist
  // Exclude any key matching config.envBlocklist
  // Blocklist wins over allowlist
```

---

## Security Considerations

- This module is the primary defense against PII leakage. It MUST default to aggressive redaction.
- The Luhn check must not have false negatives (miss real credit cards). False positives (redacting non-card numbers) are acceptable.
- Header blocklist MUST always block: `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, and any header matching `/auth|token|key|secret|password|credential/i`.
- The scrubber must handle adversarial input (deeply nested objects, getters that throw, circular references) without crashing.

---

## Edge Cases

- Value is a string containing BOTH an email and a JWT: both are redacted
- Key is `'api_key'` (matches `key` in SENSITIVE_KEY_REGEX): value redacted regardless of content
- Credit card number with spaces: current regex requires consecutive digits — spaces will NOT match. This is acceptable for v1.
- Empty string values: not redacted (no PII to detect)
- Headers with mixed case: normalized to lowercase before checking
- Custom scrubber throws: catch the error, log warning, return the default-scrubbed value

---

## Testing Requirements

- Sensitive key detection: `password`, `apiKey`, `secret_token`, `auth`, `credential`, `cvv`, `expiry_date`
- Email detection in string values
- Credit card detection with Luhn validation (valid card redacted, random 16-digit number not redacted unless Luhn-valid)
- SSN pattern detection
- JWT pattern detection
- Bearer token detection
- Recursive scrubbing through nested objects
- Depth limit at level 10
- Circular reference handling
- Header filtering: allowed header passes, blocked header removed, blocklist overrides allowlist
- File path scrubbing replaces homedir
- Database param scrubbing produces correct placeholder array
- Environment scrubbing respects allowlist and blocklist
- Custom scrubber integration (both modes)
- Input not mutated by scrubObject

---

## Completion Criteria

- `Scrubber` class and `HeaderFilter` class exported with all methods.
- All regex patterns exported from `patterns.ts`.
- Luhn validator exported and correct.
- Default scrubbing catches all documented PII patterns.
- Scrubber never throws regardless of input.
- Scrubber never mutates input objects.
- All unit tests pass.
