import { createApp } from './app.mjs';
import { createSimulatorServer, runIfMain, startServer } from '../common/server.mjs';

export const BANK_PORT = 8183;

export function createServer(options = {}) {
  const app = createApp(options);
  return createSimulatorServer({
    apps: [{ app, openapiFile: new URL('./openapi.yaml', import.meta.url) }],
    title: 'EIA bank simulator',
    defaultPort: BANK_PORT,
    host: '127.0.0.1',
  });
}

runIfMain(import.meta.url, async () => {
  const server = createServer();
  await startServer(server, { defaultPort: BANK_PORT, system: 'bank', paths: ['/sim/bank/v1'] });
});
