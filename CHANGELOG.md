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

### Added

(to be filled in as each commit lands)

### Fixed

(to be filled in as each commit lands)

### Security

- Closed an arbitrary-code-execution path in `init()` that would `require()`
  any file named `errorcore.config.js` found in the process cwd at init time.
- Hardened the CLI's config-path resolution: paths outside cwd are rejected by
  default, and non-regular-file paths (dangling symlinks, directories) are
  rejected explicitly.

## 0.1.1

Previous release. See git history.
