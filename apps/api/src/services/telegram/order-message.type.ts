import type { orderRequests, products } from "../../db/schema";


export type OrderForTgMessage = Pick<typeof orderRequests.$inferSelect, 'referenceNumber' | 'customerPhone' | 'customerTelegram' | 'customerEmail' | 'itemsTotalMinor' | 'customerName' >
export interface LineForTgMessage {
  product: Pick<typeof products.$inferSelect, 'name' | 'priceMinor'>,
  quantity: number,
}