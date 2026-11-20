import { describe, expect, it, vi } from 'vitest'
import {
	draftPopupCopy,
	fixturePopupCopy,
	fixturePopupGenerator,
	type PopupCopyFacts,
} from './popup-copy.server.ts'

const facts: PopupCopyFacts = {
	restaurantName: 'Acme Kitchen',
	offer: '10%',
	code: 'WELCOME',
	language: 'en',
}

describe('popup copy (#132)', () => {
	it('the fixture is the sentence from the issue and never needs a model', async () => {
		const copy = await draftPopupCopy(
			{ ...facts, offer: '10% off' },
			fixturePopupGenerator({ ...facts, offer: '10% off' }),
		)
		expect(copy.title).toBe('Get 10% off your first online order')
		expect(copy.body).toContain('Use code WELCOME at checkout')
		expect(copy.buttonLabel).toBe('Order now')
	})

	it('writes Arabic from the fixture too', () => {
		const copy = fixturePopupCopy({ ...facts, offer: '10%', language: 'ar' })
		expect(copy.body).toContain('WELCOME')
		expect(copy.title).toMatch(/[؀-ۿ]/u)
	})

	it('cleans a model answer: no markup, no links, cut to size', async () => {
		const generate = vi.fn(async () => ({
			title: '<b>**Big** deal</b> ' + 'x'.repeat(100),
			body: 'See https://evil.example now! Use WELCOME today',
			buttonLabel: '  Order   now  ',
		}))
		const copy = await draftPopupCopy(facts, generate)
		expect(copy.title.length).toBeLessThanOrEqual(60)
		expect(copy.title).not.toContain('<')
		expect(copy.title).not.toContain('*')
		expect(copy.body).not.toContain('http')
		expect(copy.buttonLabel).toBe('Order now')
	})

	it('keeps the coupon code in the text, adding it when the model left it out', async () => {
		const copy = await draftPopupCopy(facts, async () => ({
			title: 'Treat yourself',
			body: 'Fresh food, fast.',
			buttonLabel: 'Order',
		}))
		expect(copy.body).toContain('WELCOME')
	})

	it('falls back to the fixture when the model fails or answers nonsense', async () => {
		expect(
			await draftPopupCopy(facts, async () => {
				throw new Error('down')
			}),
		).toEqual(fixturePopupCopy(facts))
		expect(await draftPopupCopy(facts, async () => ({ title: 3 }))).toEqual(
			fixturePopupCopy(facts),
		)
		expect(
			await draftPopupCopy(facts, async () => ({
				title: '',
				body: '',
				buttonLabel: '',
			})),
		).toEqual(fixturePopupCopy(facts))
	})

	it('a popup with no coupon gets a plain invitation', () => {
		const copy = fixturePopupCopy({ ...facts, offer: null, code: null })
		expect(copy.title).toBe('Welcome to Acme Kitchen')
		expect(copy.body).not.toContain('code')
	})

	it('sends the model only the restaurant name and the coupon facts', async () => {
		const generate = vi.fn(async (ignoredArgs: { prompt: string }) =>
			fixturePopupCopy(facts),
		)
		await draftPopupCopy(facts, generate as never)
		const call = generate.mock.calls[0]![0]
		expect(call.prompt).toBe(
			'Restaurant: Acme Kitchen\nOffer: 10%. Code to use at checkout: WELCOME.',
		)
	})
})
