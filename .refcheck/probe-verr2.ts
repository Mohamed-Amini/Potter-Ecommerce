import { Elysia } from 'elysia';
import { z } from 'zod';
const app = new Elysia()
  .onError(({ code, error }) => {
    if (code === 'VALIDATION') { console.log(JSON.stringify(error.all.map((e) => ({ path: e.path, message: e.message })))); return new Response('x', { status: 422 }); }
  })
  .post('/o', ({ body }) => body, { body: z.object({ items: z.array(z.object({ quantity: z.number().int().positive() })) }) });
await app.handle(new Request('http://localhost/o', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ quantity: 2 }, { quantity: -1 }] }) }));
