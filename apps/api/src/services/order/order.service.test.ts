import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { productIdSchema, type CreateOrderRequestPayload } from '@pottery/shared';
import { db } from '../../db/client';
import { categories, orderRequestItems, orderRequests, products } from '../../db/schema';
import { NotFoundError, OutOfStockError } from '../../errors';
import { createOrderRequest } from './order.service';

// ── Test data helpers ─────────────────────────────────────────────────────────

let categoryId: string;

async function addProduct(slug: string, priceMinor: number, stockCount: number) {
  const [row] = await db
    .insert(products)
    .values({
      categoryId,
      slug,
      name: slug,
      description: 'Handmade',
      material: 'Stoneware',
      sizeLabel: '320 ml',
      priceMinor,
      stockCount,
      images: ['https://example.com/a.jpg'],
    })
    .returning();
  if (!row) throw new Error('product insert returned no row');
  return row;
}

function basket(...items: [productId: string, quantity: number][]): CreateOrderRequestPayload {
  return {
    customerName: 'Masha',
    contact: { method: 'email', value: 'masha@example.com' },
    items: items.map(([productId, quantity]) => ({
      productId: productIdSchema.parse(productId),
      quantity,
    })),
  };
}

async function stockOf(productId: string) {
  const [row] = await db
    .select({ stockCount: products.stockCount })
    .from(products)
    .where(eq(products.id, productId));
  return row?.stockCount;
}

/** Waits for a promise that should fail, and returns what it failed with. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected this to fail, but it succeeded');
}

async function countOrders() {
  return (await db.select().from(orderRequests)).length;
}

// Every test starts from empty tables. Deleting orders also deletes their lines
// (ON DELETE CASCADE).
beforeEach(async () => {
  await db.delete(orderRequests);
  await db.delete(products);
  await db.delete(categories);
  const [category] = await db.insert(categories).values({ slug: 'mugs', name: 'Mugs' }).returning();
  if (!category) throw new Error('category insert returned no row');
  categoryId = category.id;
});

// ── The tests ─────────────────────────────────────────────────────────────────

describe('createOrderRequest', () => {
  it('saves the order, merges duplicate lines and takes the stock', async () => {
    const mug = await addProduct('mug', 160_000, 4);
    const vase = await addProduct('vase', 620_000, 1);

    const { order, lines } = await createOrderRequest(basket([mug.id, 1], [mug.id, 1], [vase.id, 1]));

    // 2 mugs × 1 600 ₽ + 1 vase × 6 200 ₽ = 9 400 ₽
    expect(order.itemsTotalMinor).toBe(940_000);
    expect(order.referenceNumber).toBeGreaterThan(0);
    expect(order.contactValue).toBe('masha@example.com');

    // The two mug lines became one line with quantity 2.
    expect(lines).toHaveLength(2);
    const savedLines = await db
      .select()
      .from(orderRequestItems)
      .where(eq(orderRequestItems.orderRequestId, order.id));
    expect(savedLines).toHaveLength(2);
    expect(savedLines.find((line) => line.productId === mug.id)).toMatchObject({
      quantity: 2,
      nameSnapshot: 'mug',
      priceMinorSnapshot: 160_000,
    });

    expect(await stockOf(mug.id)).toBe(2);
    expect(await stockOf(vase.id)).toBe(0);
  });

  it('rejects a basket with too little stock, lists every problem, and saves nothing', async () => {
    const mug = await addProduct('mug', 160_000, 2);
    const vase = await addProduct('vase', 620_000, 0);

    const error = await failureOf(createOrderRequest(basket([mug.id, 5], [vase.id, 1])));

    expect(error).toBeInstanceOf(OutOfStockError);
    expect(error).toMatchObject({
      issues: [
        { path: 'items.0.quantity', message: 'Only 2 left' },
        { path: 'items.1.quantity', message: 'Only 0 left' },
      ],
    });

    expect(await countOrders()).toBe(0);
    expect(await stockOf(mug.id)).toBe(2);
  });

  it('rejects a product that does not exist', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';

    const error = await failureOf(createOrderRequest(basket([missing, 1])));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(await countOrders()).toBe(0);
  });

  it('never sells the last piece twice when two orders arrive at the same moment', async () => {
    const vase = await addProduct('vase', 620_000, 1);

    const results = await Promise.allSettled([
      createOrderRequest(basket([vase.id, 1])),
      createOrderRequest(basket([vase.id, 1])),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toBeInstanceOf(OutOfStockError);

    expect(await stockOf(vase.id)).toBe(0);
    expect(await countOrders()).toBe(1);
  });

  describe('when the stock runs out after the check but before the order is saved', () => {
    // Simulates another customer buying the vase in the gap between the stock
    // check and the transaction, so the failure happens INSIDE the transaction,
    // after the mug has already been taken.
    let restoreTransaction: (() => void) | undefined;
    afterEach(() => restoreTransaction?.());

    it('undoes everything: no order, no lines, and the mug goes back on the shelf', async () => {
      const mug = await addProduct('mug', 160_000, 4);
      const vase = await addProduct('vase', 620_000, 1);

      const realTransaction = db.transaction.bind(db);
      const spy = spyOn(db, 'transaction').mockImplementation(async (work) => {
        await db.update(products).set({ stockCount: 0 }).where(eq(products.id, vase.id));
        return realTransaction(work);
      });
      restoreTransaction = () => {
        spy.mockRestore();
      };

      const error = await failureOf(createOrderRequest(basket([mug.id, 1], [vase.id, 1])));

      expect(error).toBeInstanceOf(OutOfStockError);
      expect(error).toMatchObject({
        issues: [{ path: 'items.1.quantity', message: 'vase has just sold out' }],
      });

      expect(await countOrders()).toBe(0);
      expect(await db.select().from(orderRequestItems)).toHaveLength(0);
      expect(await stockOf(mug.id)).toBe(4);
    });
  });
});
