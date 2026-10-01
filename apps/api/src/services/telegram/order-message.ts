import type { LineForTgMessage, OrderForTgMessage } from "./order-message.type";

function formatRub(minor: number): string{
    return new Intl.NumberFormat('ru-RU',{ style: 'currency' , currency: 'RUB' , maximumFractionDigits: 0}).format(minor/100)
}

function formatContact(order:OrderForTgMessage): string {
    switch(order.contactMethod) {
        case 'telegram': 
            return`<a href="https://t.me/${order.contactValue}">@${order.contactValue}</a>`
            

        case 'phone': 
            return `Phone: ${order.contactValue}`;

        case 'email':
            return `Email: ${order.contactValue}`
    }
}

function escapeHtml(text: string): string{
    return text.replaceAll('&' , '&amp;').replaceAll('<', '&lt;').replaceAll('>' , '&gt;');
}

export function formatOrderMessage(order: OrderForTgMessage , lines: LineForTgMessage[]){
    const messageParts = [
        `<b>New Order : #${String(order.referenceNumber)}</b>`,  
        `<b>Costumer :</b>${escapeHtml(order.customerName)}. ${formatContact(order)}`,
        `<b>Items :</b> `,
        ...lines.map((line) => `${escapeHtml(line.product.name)} × ${String(line.quantity)}: ${formatRub(line.product.priceMinor * line.quantity)}`),
        `<b>Total :</b> ${formatRub(order.itemsTotalMinor)}`,
    ]
    return messageParts.join('\n');
}