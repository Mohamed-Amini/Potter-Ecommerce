
const ALPHABET   = 'QWERTYUPASDFGHJKLZXCVBNM23456789'


export function generateOrderCode(): string {

    const randomBytes = crypto.getRandomValues(new Uint8Array(6))
    const orderCode = Array.from(randomBytes).map(byte => {
        const index = byte % ALPHABET.length;

        return ALPHABET.charAt(index);
    });

    return orderCode.join('');
    
}