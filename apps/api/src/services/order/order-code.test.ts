import { describe , expect , it  } from 'bun:test';
import {generateOrderCode } from './order-code';

describe('generateOrderCode' , () => {
    const codes = Array.from({length: 1000} , generateOrderCode)

    it('is 6 characters long' , ()=> {
        for (const code of codes) expect(code).toHaveLength(6)
    })

    it('only uses allowed characters' , () => {
    for (const code of codes)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    })

    it('gives different codes' , () => {
        
        expect(new Set(codes).size).toBe(1000);
    })
})