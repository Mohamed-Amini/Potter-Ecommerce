import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { env } from './config/env';
import { categoriesRoutes } from './routes/categories.route';
import { productsRoutes } from './routes/products.route';
import { errorHandler } from './plugins/error-handler';
import { orderRequestRoute } from './routes/order-requests.route';

export const app = new Elysia()
  .use(errorHandler)
  .use(cors({ origin: env.CORS_ORIGIN }))
  .use(swagger({ path: '/docs' }))
  .get('/health', () => ({ status: 'ok' as const }))
  .use(categoriesRoutes)
  .use(productsRoutes)
  .use(orderRequestRoute)
  .listen(env.PORT);

const hostname = app.server?.hostname ?? 'localhost';
const port = app.server?.port ?? env.PORT;
console.log(`Pottery API running at http://${hostname}:${String(port)} (docs at /docs)`);
