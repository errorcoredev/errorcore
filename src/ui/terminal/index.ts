
import type { ErrorPackage } from '../../types';
import { renderHeader } from './sections/header';
import { renderOrigin } from './sections/origin';
import { renderStackTrace } from './sections/stack-trace';
import { renderSystem } from './sections/system';
import { renderRequest } from './sections/request';
import { renderIOTimeline } from './sections/io-timeline';
import { renderDbQueries } from './sections/db-queries';
import { renderLocals } from './sections/locals';

export function renderErrorRecord(pkg: ErrorPackage): string {
  const sections: string[] = [];

  sections.push(renderHeader(pkg));

  const origin = renderOrigin(pkg);
  if (origin !== null) sections.push(origin);

  sections.push(renderStackTrace(pkg));
  sections.push(renderSystem(pkg));

  const request = renderRequest(pkg);
  if (request !== null) sections.push(request);

  const io = renderIOTimeline(pkg);
  if (io !== null) sections.push(io);

  const db = renderDbQueries(pkg);
  if (db !== null) sections.push(db);

  const locals = renderLocals(pkg);
  if (locals !== null) sections.push(locals);

  return sections.join('\n') + '\n';
}
