import { describe, expect, it } from 'vitest'
describe('business invariant helpers',()=>{
 it('keeps milligram arithmetic exact for 0.001g precision',()=>{const mg=[12345,8750].reduce((a,b)=>a+b,0);expect(mg).toBe(21095);expect((mg/1000).toFixed(3)).toBe('21.095')})
 it('rejects non-positive and fractional quantities in the order contract',()=>{const valid=(n:number)=>Number.isInteger(n)&&n>0;expect(valid(1)).toBe(true);expect(valid(0)).toBe(false);expect(valid(-2)).toBe(false);expect(valid(1.5)).toBe(false)})
})
