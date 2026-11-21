import { describe, expect, it } from 'vitest'
import { buildOccasionMessage } from './occasion-message.ts'
import { OCCASION_KEYS } from './occasions.ts'

const base = {
	restaurant: 'Casa Verde',
	siteOrigin: 'https://casa-verde.menuza.site/',
	year: 2026,
}

describe('the ready-made campaign of an occasion (#152)', () => {
	it('is an email design (heading, welcome, Order button to the menu), a text and a social post', () => {
		const message = buildOccasionMessage({
			key: 'us_mothers_day',
			locale: 'en',
			...base,
		})
		expect(message.name).toBe("Mother's Day 2026")
		expect(message.subject).toBe("Mother's Day at Casa Verde")
		expect(message.blocks.map((block) => block.type)).toEqual([
			'heading',
			'body',
			'button',
		])
		const button = message.blocks[2]!
		expect(button).toMatchObject({
			type: 'button',
			config: {
				url: 'https://casa-verde.menuza.site/menu',
				label: 'Order now',
			},
		})
		expect(message.sms).toContain('Casa Verde')
		expect(message.sms).toContain('https://casa-verde.menuza.site/menu')
		expect(message.social).toContain('Casa Verde')
		expect(message.emailText).toContain("Mother's Day")
	})

	it('is written in the site language', () => {
		const ar = buildOccasionMessage({
			key: 'ksa_eid_al_fitr',
			locale: 'ar',
			...base,
		})
		expect(ar.subject).toBe('عيد الفطر في Casa Verde')
		expect(ar.blocks[2]).toMatchObject({ config: { label: 'اطلب الآن' } })
		const fr = buildOccasionMessage({
			key: 'us_christmas',
			locale: 'fr',
			...base,
		})
		expect(fr.sms).toContain('Noël')
		// An unknown language falls back to English.
		expect(
			buildOccasionMessage({ key: 'us_christmas', locale: 'xx', ...base })
				.subject,
		).toBe('Christmas at Casa Verde')
	})

	it('every occasion builds a valid design in every language, with unique block ids', () => {
		for (const key of OCCASION_KEYS) {
			for (const locale of ['en', 'ar', 'es', 'fr', 'de', 'zh']) {
				const message = buildOccasionMessage({ key, locale, ...base })
				expect(message.blocks).toHaveLength(3)
				expect(new Set(message.blocks.map((block) => block.id)).size).toBe(3)
			}
		}
	})

	it('makes no offer, price or promise of its own', () => {
		for (const key of OCCASION_KEYS) {
			const message = buildOccasionMessage({ key, locale: 'en', ...base })
			const text = `${message.subject} ${message.emailText} ${message.sms} ${message.social}`
			expect(text).not.toMatch(
				/\$|%|free|discount|off\b|coupon|\d+ ?(usd|sar)/i,
			)
		}
	})
})
