import { setupI18n } from '@lingui/core'
import {
	buildCateringQnA,
	cateringFaqJsonLd,
	defaultCateringSettings,
	type CateringSettings,
} from '@repo/common/catering'
import { describe, expect, it } from 'vitest'
import { cateringPhrases, cateringQuestionLabels } from './labels'

/**
 * "Good to know" on the catering page (#325): the typed answers show, the ones
 * that repeat a setting are read from it and follow it, and unanswered
 * questions are not shown. Built with the site's own phrases.
 */
const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
const facts = { currency: 'USD', deliveryZoneNames: [], deliveryFeeMinor: null }
const qna = (patch: Partial<CateringSettings>) =>
	buildCateringQnA(
		{ ...defaultCateringSettings(), enabled: true, ...patch },
		{
			locale: 'en',
			defaultLocale: 'en',
			facts,
			phrases: cateringPhrases(i18n),
			questionLabels: cateringQuestionLabels(i18n),
		},
	)

describe('catering answers on the page', () => {
	it('shows answers saved in the settings (325-1) and hides unanswered ones', () => {
		const entries = qna({
			questions: {
				standard: { cutlery: { en: 'Yes, we bring plates and cutlery.' } },
				custom: [],
			},
		})
		expect(entries.find((e) => e.id === 'cutlery')).toMatchObject({
			question: 'Do you provide plates, napkins and cutlery?',
			answer: 'Yes, we bring plates and cutlery.',
		})
		expect(entries.find((e) => e.id === 'dietary')).toBeUndefined()
		expect(cateringFaqJsonLd(entries)).toMatchObject({ '@type': 'FAQPage' })
	})

	it('updates the minimum notice answer when the setting changes (325-3)', () => {
		expect(
			qna({ noticeHours: 48 }).find((e) => e.id === 'notice')?.answer,
		).toContain('48')
		expect(
			qna({ noticeHours: 72 }).find((e) => e.id === 'notice')?.answer,
		).toContain('72')
	})
})
