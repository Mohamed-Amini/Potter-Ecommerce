export interface smsSender {
    send(to: string , text:string) : Promise<void>;
}

export class ConsoleSmsSender implements smsSender {
    readonly lastByNumber = new Map<string , string>();

    send(to: string , text: string): Promise<void>{
        this.lastByNumber.set(to, text);
        console.log(`[SMS] : ${to}: ${text}`)
        return Promise.resolve();
    }
}

export const smsSender: smsSender = new ConsoleSmsSender();