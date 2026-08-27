import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import analysisRouter from './routes/analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '20mb' })); // aggregated log stats/samples, never raw log files
app.use('/api', analysisRouter);

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`ESS BMS analysis backend listening on http://localhost:${port}`);
});
