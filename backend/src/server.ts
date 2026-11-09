import { config } from './config';
import { createApp } from './app';
import { registerIntegrationHandlers } from './integration/handlers';
import { startScheduler } from './jobs/scheduler';

registerIntegrationHandlers();
if (config.dqScheduler) startScheduler();

createApp().listen(config.port, () => {
  console.log(`LAOT API running on http://localhost:${config.port}/api`);
});
