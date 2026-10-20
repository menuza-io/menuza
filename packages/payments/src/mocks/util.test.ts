import { describe, expect, it } from 'vitest'
import { canonicalJson, parseFormBody, passesLuhn } from './util'

describe('parseFormBody', () => {
	it('decodes nested keys, lists and indexed lists the way Stripe does', () => {
		const body = new URLSearchParams()
		body.append('mode', 'payment')
		body.append('metadata[orderId]', 'o 1')
		body.append('payment_method_types[0]', 'card')
		body.append('line_items[0][price_data][unit_amount]', '600')
		body.append('line_items[0][quantity]', '2')
		body.append('line_items[1][price_data][unit_amount]', '100')
		body.append('expand[]', 'payment_intent')
		body.append('expand[]', 'customer')
		expect(parseFormBody(body.toString())).toEqual({
			mode: 'payment',
			metadata: { orderId: 'o 1' },
			payment_method_types: ['card'],
			line_items: [
				{ price_data: { unit_amount: '600' }, quantity: '2' },
				{ price_data: { unit_amount: '100' } },
			],
			expand: ['payment_intent', 'customer'],
		})
	})

	it('handles an empty body', () => {
		expect(parseFormBody('')).toEqual({})
	})
})

describe('helpers', () => {
	it('passesLuhn', () => {
		expect(passesLuhn('4242424242424242')).toBe(true)
		expect(passesLuhn('4242424242424241')).toBe(false)
		expect(passesLuhn('abc')).toBe(false)
	})

	it('canonicalJson ignores key order', () => {
		expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
			canonicalJson({ a: { c: 2, d: 1 }, b: 1 }),
		)
	})
})
