import type { LineForTgMessage, OrderForTgMessage } from "./order-message.type";

function formatRub(minor: number): string{
    return new Intl.NumberFormat('ru-RU',{ style: 'currency' , currency: 'RUB' , maximumFractionDigits: 0}).format(minor/100)
}


function escapeHtml(text: string): string{
    return text.replaceAll('&' , '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>' , '&gt;');
}

export function formatOrderMessage(order: OrderForTgMessage , lines: LineForTgMessage[]): string{
    const contactParts  =[ 
        `<b>Contacts :</b>`,
        `<b>Phone: </b> ${order.customerPhone}`,
        `<b>Email :</b> ${escapeHtml(order.customerEmail)}`
    ]
    if(order.customerTelegram !== null){
        contactParts.push(`<a href="https://t.me/${order.customerTelegram}">@${order.customerTelegram}</a>`)
    }

    const messageParts = [
        `<b>New Order : #${String(order.referenceNumber)}</b>`,  
        `<b>Customer :</b>${escapeHtml(order.customerName)}`,
        ...contactParts,
        `<b>Items :</b> `,
        ...lines.map((line) => `${escapeHtml(line.product.name)} × ${String(line.quantity)}: ${formatRub(line.product.priceMinor * line.quantity)}`),
        `<b>Total :</b> ${formatRub(order.itemsTotalMinor)}`,
    ]



    return messageParts.join('\n');
}