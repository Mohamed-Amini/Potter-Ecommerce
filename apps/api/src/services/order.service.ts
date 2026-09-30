import type { CreateOrderRequestPayload , ProductId } from '@pottery/shared';
import { db  } from '../db/client';
import { orderRequestItems, orderRequests, products } from '../db/schema';
import { and, eq, inArray, sql , gte } from 'drizzle-orm';
import { OutOfStockError, type Issue , NotFoundError } from '../errors';


export async function createOrderRequest(payload: CreateOrderRequestPayload ){
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

    // so that i wont forget LATER tx is for transaction look at the document of drizzle we maade ))
    return await db.transaction(async(tx)=> {
        const [order] = await tx.insert(orderRequests).values({
            customerName: payload.customerName,
            contactMethod: payload.contact.method,
            contactValue: payload.contact.value,
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

            // Takes the stock only if there is still enough of it. If another order
            // got there first, no row matches, and throwing undoes the whole transaction.
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
}

/** Where a product first appears in the basket, e.g. "items.2.quantity". */
function basketPath(payload: CreateOrderRequestPayload, productId: string): string {
    const index = payload.items.findIndex((item) => item.productId === productId);
    return `items.${String(index)}.quantity`;
}
