import { describe, expect, it } from 'vitest'
import {
	buildAiDraftContext,
	SMS_BODY_LIMIT,
	SMS_OPT_OUT_FOOTER,
} from './ai-draft-context.ts'
import {
	AiDraftError,
	buttonUrl,
	keepKnownMergeTags,
	limitLinks,
	neutralizeClaims,
	allowedMergeTags,
	sanitizeText,
	toEmailBlocks,
	toSmsMessage,
	toSubjects,
} from './ai-draft-sanitize.ts'

const context = (coupon: { headline: string; terms: string } | null = null) =>
	buildAiDraftContext({
		organization: {
			name: 'Olive',
			description: '',
			siteOrigin: 'https://olive.example.com',
		},
		menuItems: [
			{ id: 'i1', name: 'Falafel', price: 12.5, currency: 'SAR' },
			{ id: 'i2', name: 'Hummus', price: 9, currency: 'SAR' },
		],
		coupon,
	})

describe('AI draft sanitisation (#155)', () => {
	it('keeps known merge tags and removes unknown ones, keeping a fallback', () => {
		const allowed = allowedMergeTags(false)
		expect(keepKnownMergeTags('Hi {{firstName|there}}, {{secretField}} {{unknown|friend}}', allowed)).toBe(
			'Hi {{firstName|there}},  friend',
		)
		// The coupon tag only exists when a coupon is attached.
		expect(keepKnownMergeTags('Code {{couponCode}}', allowed)).toBe('Code ')
		expect(keepKnownMergeTags('Code {{couponCode}}', allowedMergeTags(true))).toBe('Code {{couponCode}}')
		// Loyalty and cart tags are not offered to a general draft.
		expect(keepKnownMergeTags('{{pointsBalance}} {{cartLink}}', allowed).trim()).toBe('')
	})

	it('removes links that are not the organization\'s own site', () => {
		const origin = 'https://olive.example.com'
		expect(
			limitLinks('See https://olive.example.com/menu and https://evil.example.net/x or www.evil.com/a', origin).replace(/\s+/g, ' ').trim(),
		).toBe('See https://olive.example.com/menu and or')
		expect(buttonUrl('/menu', origin)).toBe('https://olive.example.com/menu')
		expect(buttonUrl('https://olive.example.com/menu?item=1', origin)).toBe('https://olive.example.com/menu?item=1')
		expect(buttonUrl('https://evil.example.net', origin)).toBe('')
		expect(buttonUrl('//evil.example.net', origin)).toBe('')
		expect(buttonUrl('javascript:alert(1)', origin)).toBe('')
		expect(buttonUrl('/menu', '')).toBe('')
	})

	it('drops prices that are not on the menu, and percentages the coupon does not state', () => {
		const none = context()
		expect(neutralizeClaims('Falafel for SAR 12.5 today', none)).toBe('Falafel for SAR 12.5 today')
		expect(neutralizeClaims('Falafel for only SAR 5 today', none)).toBe('Falafel for only today')
		expect(neutralizeClaims('Get 30% off everything!', none)).toBe('Get off everything!')
		expect(neutralizeClaims('Free delivery on all orders', none)).toBe('on all orders')
		const withCoupon = context({ headline: '10% off', terms: 'Valid until Friday.' })
		expect(neutralizeClaims('Enjoy 10% off with your code', withCoupon)).toBe('Enjoy 10% off with your code')
		expect(neutralizeClaims('Enjoy 50% off with your code', withCoupon)).toBe('Enjoy off with your code')
		expect(neutralizeClaims('Only $3 and 9 SAR', none)).toBe('Only and 9 SAR')
	})

	it('sanitizeText runs all three', () => {
		const out = sanitizeText(
			'Hi {{name}} {{bad}} visit https://evil.example.net for 70% off',
			context(),
		)
		expect(out).not.toMatch(/bad|evil|70/)
		expect(out).toContain('{{name}}')
	})

	it('builds designer blocks from model blocks: real dishes only, safe button, coupon line when needed', () => {
		const blocks = toEmailBlocks(
			[
				{ type: 'heading', text: 'Meet the falafel' },
				{ type: 'paragraph', text: 'Hi {{firstName|there}}, crisp and warm.' },
				{ type: 'menu_item', itemIds: ['i1', 'ghost', 'i2', 'i1'] },
				{ type: 'menu_item', itemIds: ['ghost'] },
				{ type: 'button', label: 'Order now', url: 'https://evil.example.net' },
			],
			context({ headline: '10% off', terms: 'Friday' }),
			'en',
		)
		const types = blocks.map((b) => b.type)
		expect(types).toEqual(['heading', 'paragraph', 'menu_item', 'button', 'paragraph'])
		const dishes = blocks.find((b) => b.type === 'menu_item')
		expect((dishes as { config: { itemIds: string[] } }).config.itemIds).toEqual(['i1', 'i2'])
		expect((blocks.find((b) => b.type === 'button') as { config: { url: string } }).config.url).toBe('')
		expect(JSON.stringify(blocks[4])).toContain('{{couponCode}}')
		expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length)
	})

	it('empty or word-less output is ai_draft_invalid', () => {
		for (const blocks of [
			[],
			[{ type: 'menu_item' as const, itemIds: ['i1'] }],
			[{ type: 'paragraph' as const, text: '   ' }],
		]) {
			expect(() => toEmailBlocks(blocks, context(), 'en')).toThrow(AiDraftError)
		}
		expect(() => toSubjects(['  '], context())).toThrow(AiDraftError)
	})

	it('three subjects at most, deduplicated and cleaned', () => {
		expect(
			toSubjects(['A', 'A', 'B {{nope}}', 'C', 'D'], context()),
		).toEqual(['A', 'B', 'C'])
	})

	it('a text message plus its opt-out footer fits in 160 characters', () => {
		const long = 'Come and enjoy our famous falafel today with a fresh salad and warm bread '.repeat(6)
		const message = toSmsMessage(long, context())
		expect(message.length).toBeLessThanOrEqual(SMS_BODY_LIMIT)
		expect(message.length + SMS_OPT_OUT_FOOTER.length).toBeLessThanOrEqual(160)
		expect(toSmsMessage('Short one.', context())).toBe('Short one.')
	})
})
