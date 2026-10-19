import { createApp } from './app.mjs';
import { createSimulatorServer, runIfMain, startServer } from '../common/server.mjs';

export const S4_PORT = 8182;

/** Build (but do not start) the S/4HANA simulator HTTP server. */
export function createServer(options = {}) {
  const app = createApp(options);
  return createSimulatorServer({
    apps: [{ app, openapiFile: new URL('./openapi.yaml', import.meta.url) }],
    title: 'EIA SAP S/4HANA simulator',
    defaultPort: S4_PORT,
    host: '127.0.0.1',
  });
}

runIfMain(import.meta.url, async () => {
  const server = createServer();
  await startServer(server, {
    defaultPort: S4_PORT,
    system: 's4',
    paths: ['/sim/s4/v1'],
  });
});
