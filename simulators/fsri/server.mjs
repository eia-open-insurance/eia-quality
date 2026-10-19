import { createApp } from './app.mjs';
import { createSimulatorServer, runIfMain, startServer } from '../common/server.mjs';

export const FSRI_PORT = 8181;

/** Build (but do not start) the FS-RI simulator HTTP server. */
export function createServer(options = {}) {
  const app = createApp(options);
  return createSimulatorServer({
    apps: [{ app, openapiFile: new URL('./openapi.yaml', import.meta.url) }],
    title: 'EIA FS-RI simulator',
    defaultPort: FSRI_PORT,
    host: '127.0.0.1',
  });
}

runIfMain(import.meta.url, async () => {
  const server = createServer();
  await startServer(server, {
    defaultPort: FSRI_PORT,
    system: 'fsri',
    paths: ['/sim/fsri/v1'],
  });
});
