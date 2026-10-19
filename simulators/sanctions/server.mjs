import { createApp } from './app.mjs';
import { createSimulatorServer, runIfMain, startServer } from '../common/server.mjs';

export const SANCTIONS_PORT = 8186;

export function createServer(options = {}) {
  const app = createApp(options);
  return createSimulatorServer({
    apps: [{ app, openapiFile: new URL('./openapi.yaml', import.meta.url) }],
    title: 'EIA sanctions simulator',
    defaultPort: SANCTIONS_PORT,
    host: '127.0.0.1',
  });
}

runIfMain(import.meta.url, async () => {
  const server = createServer();
  await startServer(server, { defaultPort: SANCTIONS_PORT, system: 'sanctions', paths: ['/sim/sanctions/v1'] });
});
