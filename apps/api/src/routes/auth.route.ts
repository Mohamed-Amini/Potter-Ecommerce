import { Elysia } from 'elysia';

export const authRoutes = new Elysia({ prefix: '/auth' }).post('/request-code', ({ status }) =>
  // TODO: validate the body with requestCodeSchema, call requestCode() from
  // the auth service, and map a rate-limited result to 429.
  status(501, { message: 'Not implemented yet' }),
);
