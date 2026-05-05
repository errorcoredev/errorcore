# Spec amendments

`Errorcore_Architecture.pdf` is the canonical contract this SDK
implements. In a small number of places, the implementation deviates
from the document because the code is provably better. These
amendments are listed here so a future maintainer doesn't "fix" a
deviation by reverting to the spec text without the context.

If you are about to change one of these behaviors back to the spec,
please re-read the rationale below first, then propose the change as
a real architecture decision.

---

## 1. Locals serialization depth: 8 (spec: 3)

**Spec text.** "Local variables are serialized to depth 3."

**Implementation.** `DEFAULT_SERIALIZATION.maxDepth = 8`
(`src/config.ts`). Same value applies to `cloneAndScrub` walks across
the package.

**Rationale.** Empirical investigation on real ZodErrors and
SequelizeErrors showed depth-3 collapses meaningful debugging value
without buying meaningful payload-size savings. The single most
common pain point: `error.errors[0].path[]` and `error.issues` on
zod errors live at depth 4–5; depth-3 truncates them to
`[Object]` and the receiver can't show the user which field
failed validation.

The size cost of depth-8 vs depth-3 for typical errors is in the
tens-of-bytes range, dominated by the rest of the package. The
hard cap at 1 MB and the per-string truncation at 2 KB still
bound the total. The spec value was chosen before any field data
existed; this one is grounded in the v4 capture corpus.

---

## 2. `captureDbBindParams: true` opt-in flag (spec: "never values")

**Spec text.** "Database bind parameters are never captured."

**Implementation.** A `captureDbBindParams: boolean` config option
exists, default `false`. When `true`, query bind parameters are
captured into `dbMeta.params`.

**Rationale.** The default matches the spec — bind values are not
captured unless the operator opts in. The flag exists because
testing the recording layer for db patches genuinely requires
asserting on captured bind values, and during private-cloud or
controlled-environment debugging, an operator may want to capture
bind values for a finite window (the bind params are usually less
sensitive than the surrounding statement).

The flag is documented as an explicit opt-in; the default
behavior is bit-for-bit what the spec asks for. The deviation is
that the flag exists, not that its default differs.

---

## 3. DLQ line-level integrity uses HMAC-SHA256 (spec: CRC32 + HMAC)

**Spec text.** "Each DLQ line carries a CRC32 of the payload bytes
and an HMAC-SHA256 over the line."

**Implementation.** Each DLQ line carries an HMAC-SHA256 only.
CRC32 is not stored.

**Rationale.** The spec's CRC32 is intended to detect torn writes
(partial line append after a crash). HMAC-SHA256 detects torn
writes too — any byte missing from the line invalidates the HMAC
just as readily as it invalidates a CRC. CRC32 catches NOTHING
that HMAC misses; it just adds 4 bytes per line and a code path
to maintain. The receiver flow is also simpler: one verification
check, not two.

The integrity property the spec was protecting (no torn writes,
no tampering) is fully preserved.

---

## When to update this document

- When a deviation is introduced that you intend to keep.
- When a deviation is removed (the entry is deleted, not just
  struck through).
- When the spec is amended to match the implementation (the entry
  is removed because the spec now describes what the SDK does).

Reference this document from `CHANGELOG.md` whenever an
implementation choice is made that conflicts with the spec.
