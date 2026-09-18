import type { Logger } from 'pino';
import { exportJobRepository } from './export-job-store';
import { EXPORT_CONCURRENCY, processExportJob, type ExportJobRepository, type ExportJobStorage, type ClaimedExport, type ExportArtifact } from './export-jobs';
import { exportJobStorage, generateExportArtifact } from './valopay-exports';

type Dependencies = { repository?: ExportJobRepository; storage?: ExportJobStorage; generate?: (claim: ClaimedExport) => Promise<{ bytes: Buffer; artifact: ExportArtifact }>; log?: Logger };
/** At most two generation/uploads per process. Durable queue rows, not in-memory promises, own outstanding work. */
export async function runExportPass(deps: Dependencies = {}) {
  const repository = deps.repository || exportJobRepository;
  const targets = await repository.candidates(20);
  const results: Array<'ready'|'failed'|'skipped'>=[];
  let next=0;
  await Promise.all(Array.from({length:EXPORT_CONCURRENCY},async()=>{
   while(next<targets.length){
    const target=targets[next++]!;
    try {
      const status = await processExportJob(repository, deps.storage || exportJobStorage, deps.generate || generateExportArtifact, target);
      deps.log?.info({ event: 'export.job', exportId: target.id, status }, 'Export worker attempt completed');
      results.push(status);
    } catch (error) {
      deps.log?.error({ event: 'export.worker_error', exportId: target.id, err: error }, 'Export worker could not claim a job');
      results.push('failed');
    }
   }
  }));
  return results;
}
export function startExportWorker(deps: Dependencies & { intervalMs?: number } = {}) {
  let running: Promise<unknown> | null = null, stopped = false;
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = runExportPass(deps).catch(error => deps.log?.error({ event: 'export.queue_error', err: error }, 'Export queue could not be checked')).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => { void tick(); }, deps.intervalMs ?? 1500); timer.unref();
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); }, settle: async () => { await running; }, tick };
}
