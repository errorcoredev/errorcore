# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres
to Semantic Versioning once it reaches 1.0.0; until then, breaking changes may
ship in any minor release and are called out under the BREAKING heading.

## 0.2.0 (unreleased)

Coordinated P0+P1 production readiness pass. Several defaults tightened and
unsafe implicit behaviors removed.

### BREAKING

- `init()` no longer auto-loads `./errorcore.config.js` from the current
  working directory. Callers must pass configuration explicitly, for example
  `errorcore.init(require('./errorcore.config.js'))`. The previous behavior
  executed an arbitrary JS file whose path was only controlled by the process
  cwd at startup, which was an RCE surface for any entry point that ran
  errorcore with an attacker-controlled cwd.
- The `errorcore` CLI (`validate`, `status`, `drain`, `ui`) refuses to load a
  config file located outside the current working directory unless the new
  `--allow-external-config` flag is passed.
- `Encryption.prototype.getHmacKeyHex()` is removed. Consumers that signed
  their own payloads by pulling the HMAC key out of the Encryption instance
  now call `encryption.sign(serializedPayload)` instead. The HMAC key never
  leaves the Encryption instance.
- `allowUnencrypted` no longer defaults based on `NODE_ENV`. The default is
  now `false` unconditionally. Callers that previously relied on the dev
  fallback (`NODE_ENV !== 'production'` implicitly enabling plaintext) must
  set `allowUnencrypted: true` explicitly in their config. The previous
  behavior silently disabled encryption when `NODE_ENV` was missing or
  misspelled (for example `NODE_ENV=prod` or `NODE_ENV=Production`).
- `allowInsecureTransport` is removed. It was a silent alias for
  `allowPlainHttpTransport`. `resolveConfig` throws a clear error if the
  removed name is passed. `ResolvedConfig.allowInsecureTransport` is no
  longer emitted.
- `encryptionKey` validation raises the minimum character-diversity (Shannon
  entropy) from 2.0 to 3.5 bits per character. A uniformly random 32-byte
  hex key scores ~3.93 so `crypto.randomBytes(32).toString('hex')` still
  passes. A four-distinct-character repeating pattern that previously
  scraped by is now rejected.

### Added

- `Encryption.sign(serializedPackage)` returns an HMAC-SHA256 signature of the
  argument using the internally-derived HMAC key. Derivation parameters are
  unchanged, so signatures remain bitwise identical to the previous external
  `createHmac('sha256', getHmacKeyHex()).update(...).digest('base64')`
  formulation. Existing signed dead-letter entries still verify.

### Fixed

(to be filled in as each commit lands)

### Security

- Closed an arbitrary-code-execution path in `init()` that would `require()`
  any file named `errorcore.config.js` found in the process cwd at init time.
- Hardened the CLI's config-path resolution: paths outside cwd are rejected by
  default, and non-regular-file paths (dangling symlinks, directories) are
  rejected explicitly.
- The derived HMAC signing key is no longer exposed via a public method. The
  signing operation now happens inside `Encryption` itself. Constant-time
  comparison (`crypto.timingSafeEqual`) replaces `Buffer.equals` when
  detecting whether a ciphertext uses the legacy per-message salt scheme; this
  removes a salt-matching timing oracle on decrypt.

## 0.1.1

Previous release. See git history.
