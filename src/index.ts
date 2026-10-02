import { readConfig } from './config.js';
import { createProvider } from './provider.js';
import { buildServer } from './server.js';

const config = readConfig();
const provider = await createProvider(config);
try {
  const app = await buildServer(config, provider);
  await app.listen({ host: '127.0.0.1', port: config.port });
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} catch (error) {
  await provider.close();
  throw error;
}
