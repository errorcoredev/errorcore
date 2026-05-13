import { describe, expect, it } from 'vitest';

import {
  analyzeStackOwnership,
  classifyFramePath,
  extractNodeModulesPackageName
} from '../../../src/capture/stack-ownership';

describe('stack ownership classification', () => {
  it('classifies node_modules and node: frames as external', () => {
    expect(classifyFramePath('/srv/app/src/routes.ts')).toBe('app');
    expect(classifyFramePath('/srv/app/node_modules/@prisma/client/index.js')).toBe(
      'external'
    );
    expect(classifyFramePath('node:internal/process/task_queues')).toBe('external');
  });

  it('extracts scoped and unscoped package names from node_modules paths', () => {
    expect(
      extractNodeModulesPackageName('/srv/app/node_modules/@prisma/client/runtime.js')
    ).toBe('@prisma/client');
    expect(extractNodeModulesPackageName('/srv/app/node_modules/zod/index.js')).toBe(
      'zod'
    );
  });

  it('summarizes an external-origin error with the first app boundary frame', () => {
    const stack = [
      'PrismaClientKnownRequestError: unique constraint failed',
      '    at request (/srv/app/node_modules/@prisma/client/runtime/index.js:10:5)',
      '    at getUser (/srv/app/src/services/user.ts:42:7)',
      '    at handler (/srv/app/src/routes.ts:12:3)'
    ].join('\n');

    expect(analyzeStackOwnership(stack)).toMatchObject({
      origin: 'external',
      package: '@prisma/client',
      externalFramesCollapsed: true,
      externalFrameCount: 1,
      appFrameCount: 2,
      appBoundaryFrame: {
        functionName: 'getUser',
        filePath: '/srv/app/src/services/user.ts',
        lineNumber: 42,
        columnNumber: 7
      }
    });
  });

  it('falls back to package metadata when every frame is external', () => {
    const stack = [
      'ZodError: invalid input',
      '    at parse (/srv/app/node_modules/zod/index.js:10:5)',
      '    at run (/srv/app/node_modules/zod/helpers.js:11:6)'
    ].join('\n');

    const ownership = analyzeStackOwnership(stack);

    expect(ownership).toMatchObject({
      origin: 'external',
      package: 'zod',
      externalFramesCollapsed: true
    });
    expect(ownership.appBoundaryFrame).toBeUndefined();
  });
});
