import { formatPercent } from './format'
import { loyaltyNoticeText } from './notice-text'
import { catalogI18n, testI18n } from '@/test/loyalty/i18n'

const iso = (value: string) => `\u2068${value}\u2069`

describe('loyaltyNoticeText', () => {
	const i18n = testI18n()

	it('words each success with the reward name kept in its own direction', () => {
		expect(
			loyaltyNoticeText(i18n, {
				kind: 'success',
				reason: 'approved',
				rewardName: 'Free latte',
			}),
		).toBe(`Approved: ${iso('Free latte')}.`)
		expect(
			loyaltyNoticeText(i18n, {
				kind: 'success',
				reason: 'declined',
				rewardName: 'Free latte',
			}),
		).toBe(`Declined: ${iso('Free latte')}.`)
	})

	it('maps an error code to its message', () => {
		expect(
			loyaltyNoticeText(i18n, { kind: 'error', code: 'approval_expired' }),
		).toBe('That request has expired.')
		expect(loyaltyNoticeText(i18n, { kind: 'error', code: 'network' })).toBe(
			'Network error. Check your connection and try again.',
		)
	})

	it('uses the app translations', () => {
		const arabic = catalogI18n('ar')
		const text = loyaltyNoticeText(arabic, {
			kind: 'success',
			reason: 'approved',
			rewardName: 'Free latte',
		})
		expect(text).not.toContain('Approved')
		expect(text.length).toBeGreaterThan(0)
	})
})

describe('formatPercent', () => {
	it('formats with Western digits in every language', () => {
		expect(formatPercent(57, 'en')).toBe('57%')
		expect(formatPercent(57, 'ar')).toMatch(/57/)
		expect(formatPercent(0, 'de')).toMatch(/0\s?%/)
	})
})
