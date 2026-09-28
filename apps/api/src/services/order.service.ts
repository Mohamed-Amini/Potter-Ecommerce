import type { CreateOrderRequestPayload , ProductId } from '@pottery/shared';
import { db } from '../db/client';
import { products } from '../db/schema';
import { inArray } from 'drizzle-orm';
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

    for (const [productId, wantedQuantity] of basketItems) {
        const product = productById.get(productId)
        if(!product) {
            throw new NotFoundError('Product' , productId);
        }

        if(wantedQuantity > product.stockCount){
            const index = payload.items.findIndex((item) => item.productId === productId);
            issues.push({
                path: `items.${String(index)}.quantity`,
                message: `Only ${String(product.stockCount)} left`
            })

            if(issues.length > 0) throw new OutOfStockError(issues);
        }
    }

}  