import { env } from "../../config/env";


export async function sendTelegramMessage(text: string): Promise<void>{
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage` ,{
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({chat_id: env.TELEGRAM_CHAT_ID , text , parse_mode: 'HTML'}),
    })

    if(!response.ok){
        const reply = await response.text();
        throw new Error(`Telegram sending Message failed ${String(response.status)} ${reply}`)
    }
}