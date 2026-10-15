import { startLocalWorker } from './analysis-worker.ts';
import { Store } from './store.ts';
import { createApp } from './app.ts';
if (process.env.NODE_ENV === 'production') throw new Error('Local authentication/storage only. AWS authentication and storage must be verified before deployment.');
const store = new Store(process.env.ACCORD_DATABASE ?? '.local/accord.sqlite');
const port = Number(process.env.PORT ?? 3001);
const server = createApp(store, process.env.ACCORD_ORIGIN).listen(port, '127.0.0.1', () => console.log(`Accord local API: http://127.0.0.1:${port}/api`));
const stopWorker = startLocalWorker(store, { enabled: () => process.env.ACCORD_ANALYSIS_ENABLED !== 'false' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { void stopWorker().then(() => { store.close(); process.exit(0); }); }));
