import { Elysia } from 'elysia';
import { apiErrorSchema, createOrderRequestSchema, orderRequestSchema } from '@pottery/shared';
import { createOrderRequest } from '../services/order/order.service';
import { sendTelegramMessage } from '../services/telegram/telegram.service';
import { formatOrderMessage } from '../services/telegram/order-message';


export const orderRequestRoute = new Elysia({prefix:'/order-requests'})


    // big security fualt i must add this to the admin-orders.route.ts
    // .get('/',
    //     async() => {
    //         const rows = await db.select().from(orderRequests);
    //         return rows.map((row) => orderRequestSchema.parse(row))
    //     },
    //     {
    //         response: orderRequestSchema.array(),
    //     }
    // )
    // .get('/:id', async({params , status}) => {
    //     const [rows] = await db.
    //     select()
    //     .from(orderRequests)
    //     .where(eq(orderRequests.id ,params.id))

    //     if (!rows){
    //         return status(404, {code: 'NOT_FOUND' , message:`the ${params.id} not FOUND`})
    //     }
    //     return orderRequestSchema.parse(rows);
    // },{
    //     params: z.object({id : z.uuid()}),
    //     response:{
    //         404 : apiErrorSchema,
    //         200:  orderRequestSchema,
    //     }
    // }
    // )
    .post('/',
        async({body, status}) => {
            const { order , lines} = await createOrderRequest(body);
            sendTelegramMessage(formatOrderMessage(order , lines)).catch((error: unknown) => {
                console.error('Telegram notification failed', error)
            })
            return status(201 , orderRequestSchema.parse({
                id : order.id,
                referenceNumber: order.referenceNumber,
                customerName: order.customerName,
                contact: {method: order.contactMethod , value: order.contactValue},
                note: order.note,
                itemsTotalMinor: order.itemsTotalMinor,
                agreedTotalMinor: order.agreedTotalMinor,
                status: order.status,
                items: lines.map(({product , quantity}) => ({
                    productId: product.id,
                    name: product.name,
                    priceMinor: product.priceMinor,
                    quantity
                })),
                createdAt: order.createdAt.toISOString(),
            }))
        },{
            body: createOrderRequestSchema,
            response: {
                201: orderRequestSchema,
                404: apiErrorSchema,
                409: apiErrorSchema
            }

        }
    )
    