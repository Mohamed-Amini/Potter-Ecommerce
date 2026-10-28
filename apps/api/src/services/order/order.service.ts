import type { CreateOrderRequestPayload , ProductId } from '@pottery/shared';
import { db  } from '../../db/client';
import { orderRequestItems, orderRequests, products } from '../../db/schema';
import { and, eq, inArray, sql , gte } from 'drizzle-orm';
import { OutOfStockError, type Issue , NotFoundError } from '../../errors';
import { isUniqueViolation } from '../../utils/Errors.util';
import { generateOrderCode } from './order-code';

const MAX_CODE_ATTEMPTS = 3;
const ORDER_CODE_CONSTRAINT = 'order_requests_order_code_unique';

// `generateCode` is a parameter (with a default) so a test can hand in a fake
// generator and force a collision. Normal callers never pass it.
export async function createOrderRequest(
    payload: CreateOrderRequestPayload,
    generateCode: () => string = generateOrderCode,
){
    const basketItems = new Map<ProductId , number>();
    for (const item of payload.items) {
        const itemQuantity = basketItems.get(item.productId) ?? 0;
        basketItems.set(item.productId , itemQuantity + item.quantity)
    }

    const basketProductIds = Array.from<ProductId>(basketItems.keys());
    const rows = await db.select().from(products).where(inArray(products.id, basketProductIds));
    const productById = new Map(rows.map((row)=> [row.id , row]))
    const issues: Issue[] = [];

    let itemsTotalMinor = 0;

    const lines: {product: typeof rows[number]; quantity: number}[] = [];
    for (const [productId, wantedQuantity] of basketItems) {
        const product = productById.get(productId)

        if(!product) {
            throw new NotFoundError('Product' , productId);
        }

        if(wantedQuantity > product.stockCount){
            issues.push({
                path: basketPath(payload, productId),
                message: `Only ${String(product.stockCount)} left`
            })
        }
        itemsTotalMinor += product.priceMinor * wantedQuantity;

        lines.push({product , quantity: wantedQuantity})
    }
    if(issues.length > 0) throw new OutOfStockError(issues);

    // The whole transaction is retried, not just the insert: once a statement fails
    // inside a Postgres transaction, the transaction is dead and has to be rolled back.
    // A fresh code is generated on every attempt (generateCode() is called inside).
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        try {
            return await db.transaction(async(tx)=> {
                const [order] = await tx.insert(orderRequests).values({
                    customerName: payload.customerName,
                    customerPhone: payload.customerPhone,
                    customerEmail: payload.customerEmail,
                    orderCode: generateCode(),
                    customerTelegram: payload.customerTelegram ?? null,
                    note: payload.note ?? null,
                    itemsTotalMinor: itemsTotalMinor,
                }).returning()

                if(!order){
                    throw new Error('Order Insert Returned No Rows')
                }

                for (const { product , quantity } of lines){
                    await tx.insert(orderRequestItems).values({
                        orderRequestId: order.id,
                        productId: product.id,
                        nameSnapshot: product.name,
                        priceMinorSnapshot: product.priceMinor,
                        quantity
                    });

                    const updated = await tx.update(products)
                    .set({stockCount : sql`${products.stockCount} - ${quantity}`})
                    .where(and(eq(products.id , product.id) , gte(products.stockCount , quantity)))
                    .returning({ stockCount: products.stockCount});

                    if(updated.length === 0 ){
                        throw new OutOfStockError([{
                            path: basketPath(payload, product.id),
                            message: `${product.name} has just sold out`
                        }]);
                    }
                }
                return { order, lines };
            })
        } catch (error) {
            // Retry only if THIS constraint collided and there are attempts left.
            // Any other error (out of stock, a different unique rule…) goes up unchanged.
            const codeWasTaken = isUniqueViolation(error) && error.cause.constraint_name === ORDER_CODE_CONSTRAINT;
            if (codeWasTaken && attempt < MAX_CODE_ATTEMPTS) continue;
            throw error;
        }
    }

    // Unreachable (the last attempt either returns or throws), but TypeScript can't see that.
    throw new Error('Could not create an order');
}

function basketPath(payload: CreateOrderRequestPayload, productId: string): string {
    const index = payload.items.findIndex((item) => item.productId === productId);
    return `items.${String(index)}.quantity`;
}
