import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Request } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { authenticate, authorize } from './middlewares/auth';
import { errorHandler, notFoundHandler } from './middlewares/error';
import { authRouter } from './modules/auth/routes';
import { membersRouter } from './modules/members/routes';
import { packagesRouter } from './modules/packages/routes';
import { adminRouter } from './modules/admin/routes';
import { checkinsRouter } from './modules/checkins/routes';
import { contractsRouter } from './modules/contracts/routes';
import { paymentsRouter } from './modules/payments/routes';
import { reportsRouter } from './modules/reports/routes';
import { shiftsRouter } from './modules/shifts/routes';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      hsts: { maxAge: 31536000, includeSubDomains: true },
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  if (config.allowedOrigins.length) app.use(cors({ origin: config.allowedOrigins, credentials: true }));
  if (config.APP_ENV !== 'test') app.use(pinoHttp({ logger }));
  app.use(
    express.json({
      limit: '300kb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRouter);

  app.get('/api/me', authenticate, authorize('me.read'), async (req, res) => {
    const a = req.access!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    const branches = await prisma.branch.findMany({
      where: a.roles.includes('super_admin') || a.allBranches ? {} : { id: { in: a.branchIds } },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true },
    });
    res.json({
      data: { id: user.id, email: user.email, name: user.name, roles: a.roles, permissions: a.permissions, branches },
    });
  });

  app.use('/api/members', membersRouter);
  app.use('/api/packages', packagesRouter);
  app.use('/api/contracts', contractsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/checkins', checkinsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
