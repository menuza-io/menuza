import { describe, expect, it } from 'vitest'
import {
	bestSellersSchema,
	buildAiDraftContext,
	buildAiDraftPrompt,
	SMS_BODY_LIMIT,
	SMS_MAX_LENGTH,
	SMS_OPT_OUT_FOOTER,
} from './ai-draft-context.ts'

// Customer-looking data that must never reach the model.
const PERSONAL = {
	customerName: 'Rana Khalid',
	name_of_guest: 'Rana Khalid',
	email: 'rana@example.com',
	phone: '+15551234567',
	orders: [{ id: 'ord_1', total: 4200 }],
	customerId: 'cust_secret_1',
	allergyNotes: 'peanut allergy',
}

const input = () => ({
	organization: {
		name: 'Olive & Co',
		description: 'Mediterranean kitchen in Riyadh.',
		siteOrigin: 'https://olive.example.com',
		...PERSONAL,
	},
	menuItems: [
		{ id: 'i1', name: 'Falafel', description: 'Crisp.', priceMinor: 1250, currency: 'SAR', ...PERSONAL },
		{ id: 'i2', name: 'Hummus', description: '', price: 9, currency: 'SAR' },
	],
	selectedItemIds: ['i1', 'unknown'],
	bestSellers: [
		{ itemId: 'i2', count: 40, ...PERSONAL },
		{ itemId: 'zzz', count: 99 },
	],
	coupon: { headline: '10% off', terms: 'Valid until Friday.', ...PERSONAL },
	...PERSONAL,
})

describe('AI draft context (#155)', () => {
	it('copies only the closed list of fields: no personal field can enter', () => {
		const context = buildAiDraftContext(input() as never)
		const text = JSON.stringify(context)
		for (const value of [
			'Rana',
			'rana@example.com',
			'+1555',
			'ord_1',
			'cust_secret_1',
			'peanut',
		]) {
			expect(text).not.toContain(value)
		}
		for (const key of ['customerName', 'email', 'phone', 'orders', 'customerId', 'allergyNotes']) {
			expect(text).not.toContain(`"${key}"`)
		}
		expect(context.organization).toEqual({
			name: 'Olive & Co',
			description: 'Mediterranean kitchen in Riyadh.',
			siteOrigin: 'https://olive.example.com',
		})
		expect(context.menuItems.map((i) => [i.id, i.price])).toEqual([
			['i1', 12.5],
			['i2', 9],
		])
	})

	it('keeps only known dishes and best sellers, most sold first, and the coupon words', () => {
		const context = buildAiDraftContext(input() as never)
		expect(context.selectedItemIds).toEqual(['i1'])
		expect(context.bestSellers).toEqual([{ itemId: 'i2', count: 40 }])
		expect(context.coupon).toEqual({ headline: '10% off', terms: 'Valid until Friday.' })
	})

	it('the prompt a model gets holds no guest data either', () => {
		const context = buildAiDraftContext(input() as never)
		for (const channel of ['email', 'sms'] as const) {
			const { system, prompt } = buildAiDraftPrompt(context, {
				channel,
				goal: 'announce_dish',
				tone: 'friendly',
				language: 'en',
			})
			const all = `${system}\n${prompt}`
			for (const value of ['Rana', 'rana@', '+1555', 'ord_1', 'cust_secret_1', 'peanut']) {
				expect(all).not.toContain(value)
			}
			expect(all).toContain('Falafel')
			expect(all).toContain('{{couponCode}}')
		}
	})

	it('names no coupon tag and no offer when none is attached', () => {
		const context = buildAiDraftContext({ ...input(), coupon: null } as never)
		const { system, prompt } = buildAiDraftPrompt(context, {
			channel: 'email',
			goal: 'win_back',
			tone: 'urgent',
			language: 'ar',
		})
		expect(system).not.toContain('{{couponCode}}')
		expect(prompt).toContain('do not offer any discount')
		expect(system).toContain('Arabic')
	})

	it('best sellers from the browser are validated strictly: ids and counts only', () => {
		expect(bestSellersSchema.safeParse([{ itemId: 'a', count: 3 }]).success).toBe(true)
		expect(bestSellersSchema.safeParse([{ itemId: 'a', count: 3, name: 'x' }]).success).toBe(false)
		expect(bestSellersSchema.safeParse([{ itemId: 'a', count: -1 }]).success).toBe(false)
		expect(bestSellersSchema.safeParse([{ itemId: 'a', count: 1.5 }]).success).toBe(false)
	})

	it('leaves room for the opt-out footer in a text message', () => {
		expect(SMS_BODY_LIMIT + SMS_OPT_OUT_FOOTER.length).toBe(SMS_MAX_LENGTH)
	})
})
