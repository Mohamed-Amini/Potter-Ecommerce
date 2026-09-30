import { Elysia } from 'elysia';
import { db } from '../db/client';
import {orderRequests} from '../db/schema'
import { apiErrorSchema, createOrderRequestSchema, orderRequestIdSchema, orderRequestSchema } from '@pottery/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';


export const orderRequestRoute = new Elysia({prefix:'/order-request'})
    .get('/',
        async() => {
            const rows = await db.select().from(orderRequests);
            return rows.map((row) => orderRequestSchema.parse(row))
        },
        {
            response: orderRequestSchema.array(),
        }
    )
    .get('/:id', async({params , status}) => {
        const [rows] = await db.
        select()
        .from(orderRequests)
        .where(eq(orderRequests.id ,params.id))

        if (!rows){
            return status(404, {code: 'NOT_FOUND' , message:`the ${params.id} not FOUND`})
        }
        return orderRequestSchema.parse(rows);
    },{
        params: z.object({id : z.uuid()}),
        response:{
            404 : apiErrorSchema,
            200:  orderRequestSchema,
        }
    }
    )
    .post('/',
        async({body, status}) => {
            const [rows] = await db
            .insert(orderRequests)
            .values({ id: orderRequestIdSchema.parse(crypto.randomUUID), ...body})
            .returning()
            return status(201 ,  orderRequestSchema.parse(rows));
        },{
            body: createOrderRequestSchema,
            response: {
                201: orderRequestSchema,
            }

        }
    )