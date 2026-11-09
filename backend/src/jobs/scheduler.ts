import cron from 'node-cron';
import { runFullScan } from '../dq/scan';

// Scheduled data quality scan: every 15 minutes.
// Catches time-based problems (expired lots, missing temperature logs,
// landings not graded) that no user action would trigger.
export function startScheduler() {
  let running = false;
  cron.schedule('*/15 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const r = await runFullScan();
      const found = r.rules.reduce((s, x) => s + x.found, 0);
      console.log(`[DQ scan] ${found} findings, ${r.quarantined} lots quarantined, ${r.durationMs} ms`);
    } catch (e) {
      console.error('[DQ scan] failed', e);
    } finally {
      running = false;
    }
  });
  console.log('DQ scheduler: full scan every 15 minutes');
}
