import { Elysia } from 'elysia';
import { z } from 'zod';
const app = new Elysia()
  .onError(({ code, error }) => {
    if (code === 'VALIDATION') {
      const all = error.all;
      console.log('all.length', all.length, 'first keys', Object.keys(all[0] ?? {}).join(','));
      console.log('first', JSON.stringify(all[0]).slice(0, 300));
      return new Response('x', { status: 422 });
    }
  })
  .post('/o', ({ body }) => body, { body: z.object({ name: z.string().min(1), items: z.array(z.object({ quantity: z.number().int().positive() })) }) });
await app.handle(new Request('http://localhost/o', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '', items: [{ quantity: -1 }] }) }));
await app.handle(new Request('http://localhost/o', { method: 'POST', body: 'not json' }));
