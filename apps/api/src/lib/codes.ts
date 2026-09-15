export function generateCode(): string {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return String((buffer[0] ?? 0) % 1_000_000).padStart(6 , '0');
}

export function hashCode(code : string): Promise<string> {
    return Bun.password.hash(code);
}

export function matchesHash(code: string , hash: string): Promise<boolean> {
    return Bun.password.verify(code , hash)
}