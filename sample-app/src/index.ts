import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import tasksRouter from './routes/tasks';

const app = express();
const PORT = process.env.PORT ?? 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/.well-known/aws/securityagent-domain-verification.json', (_req, res) => {
  res.json({ tokens: [process.env.DOMAIN_VERIFICATION_TOKEN ?? ''] });
});

app.use(tasksRouter);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start server (skip when imported for testing)
// ---------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PRISM sample-app listening on http://localhost:${PORT}`);
  });
}

export default app;
