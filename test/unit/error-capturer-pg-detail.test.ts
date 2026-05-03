import { describe, expect, it } from 'vitest';

import { extractCustomProperties } from '../../src/capture/error-capturer';

// Reproduces the shape of pg's DatabaseError without requiring the pg driver
// at test time. The constructor name and the constellation of pg-specific
// fields (severity, code, routine, constraint) drive the detection branch.
function makeFakePgDatabaseError(extra: Record<string, unknown> = {}): Error {
  class DatabaseError extends Error {}
  const e = new DatabaseError('duplicate key value violates unique constraint "users_email_key"');
  Object.assign(e, {
    severity: 'ERROR',
    code: '23505',
    schema: 'public',
    table: 'users',
    constraint: 'users_email_key',
    routine: 'ExecConstraints',
    detail: 'Key (email)=(victim@example.com) already exists.',
    hint: 'Consider using ON CONFLICT.',
    internalQuery: 'SELECT 1',
    where: 'PL/pgSQL function foo() line 3',
    file: 'execMain.c',
    line: '420',
    column: '5',
    ...extra
  });
  return e;
}

describe('extractCustomProperties — pg DatabaseError detail strip', () => {
  it('strips detail/hint/internalQuery/where for a pg DatabaseError', () => {
    const error = makeFakePgDatabaseError();
    const properties = extractCustomProperties(error);

    expect(properties.detail).toBeUndefined();
    expect(properties.hint).toBeUndefined();
    expect(properties.internalQuery).toBeUndefined();
    expect(properties.where).toBeUndefined();
  });

  it('keeps non-PII pg fields used for debugging', () => {
    const error = makeFakePgDatabaseError();
    const properties = extractCustomProperties(error);

    expect(properties.code).toBe('23505');
    expect(properties.severity).toBe('ERROR');
    expect(properties.schema).toBe('public');
    expect(properties.table).toBe('users');
    expect(properties.constraint).toBe('users_email_key');
    expect(properties.routine).toBe('ExecConstraints');
    expect(properties.file).toBe('execMain.c');
    expect(properties.line).toBe('420');
    expect(properties.column).toBe('5');
  });

  it('detects pg DatabaseError by class name', () => {
    class DatabaseError extends Error {}
    const error = new DatabaseError('boom');
    Object.assign(error, { detail: 'Failing row contains (...).' });

    const properties = extractCustomProperties(error);

    expect(properties.detail).toBeUndefined();
  });

  it('detects pg DatabaseError by field constellation when class name is stripped', () => {
    // Some bundlers strip class names. Fingerprint by severity + code + routine.
    const error = new Error('constraint violation');
    Object.assign(error, {
      severity: 'ERROR',
      code: '23514',
      routine: 'ExecConstraints',
      detail: 'Failing row contains (33333333, Sold-Out C, -5, 9999).'
    });

    const properties = extractCustomProperties(error);

    expect(properties.detail).toBeUndefined();
    expect(properties.code).toBe('23514');
  });

  it('does not strip detail from a non-pg Error that happens to have a detail field', () => {
    const error = new Error('app error');
    Object.assign(error, { detail: 'this is a feature description, not a row dump' });

    const properties = extractCustomProperties(error);

    expect(properties.detail).toBe('this is a feature description, not a row dump');
  });

  it('does not strip detail when only one pg-specific field is present', () => {
    const error = new Error('something');
    Object.assign(error, {
      // Only `severity` and `code` — missing routine/constraint, so it's not
      // confidently a pg DatabaseError. Don't strip.
      severity: 'WARN',
      code: 'CUSTOM',
      detail: 'a useful bit of context'
    });

    const properties = extractCustomProperties(error);

    expect(properties.detail).toBe('a useful bit of context');
  });
});
