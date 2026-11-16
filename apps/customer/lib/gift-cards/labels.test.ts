import {
	GIFT_CARD_ERROR_CODES,
	GIFT_CARD_LEDGER_KINDS,
} from '@repo/common/gift-cards'
import { type GiftCardsClientErrorCode } from './gift-cards-client'
import {
	GIFT_CARD_LABELS,
	giftCardActivityText,
	giftCardErrorText,
	giftCardStatusText,
	giftCardUsable,
	renderGiftCardLabel,
} from './labels'
import { testI18n } from '@/test/loyalty/i18n'

const CLIENT_CODES: GiftCardsClientErrorCode[] = [
	'signed_out',
	'organization_mismatch',
	'organization_not_found',
	'network',
	'invalid_response',
	'unknown',
]

describe('gift card labels', () => {
	it('has a non-empty English source for every key', () => {
		for (const [key, descriptor] of Object.entries(GIFT_CARD_LABELS)) {
			expect({ key, message: descriptor.message }).not.toEqual({
				key,
				message: '',
			})
		}
	})

	it('fills placeholders', () => {
		const i18n = testI18n('en')
		expect(renderGiftCardLabel(i18n, 'cardEndingIn', { last4: '7K2M' })).toBe(
			'Gift card ending in 7K2M',
		)
		expect(renderGiftCardLabel(i18n, 'addSaved', { last4: '7K2M' })).toContain(
			'7K2M',
		)
	})

	it('words every error, never leaving a blank or a raw code', () => {
		const i18n = testI18n('en')
		for (const code of [...GIFT_CARD_ERROR_CODES, ...CLIENT_CODES]) {
			const text = giftCardErrorText(i18n, code)
			expect(text.length).toBeGreaterThan(10)
			expect(text).not.toBe(code)
		}
	})

	it('answers a wrong or unusable code with one wording, naming no reason', () => {
		const i18n = testI18n('en')
		const wrong = giftCardErrorText(i18n, 'code_invalid')
		expect(giftCardErrorText(i18n, 'not_found')).toBe(wrong)
		expect(giftCardErrorText(i18n, 'invalid_request')).toBe(wrong)
		const unusable = giftCardErrorText(i18n, 'gift_card_frozen')
		for (const code of [
			'gift_card_held',
			'gift_card_voided',
			'gift_card_expired',
		] as const) {
			expect(giftCardErrorText(i18n, code)).toBe(unusable)
		}
	})

	it('tells the guest about a status that matters, and only that', () => {
		const i18n = testI18n('en')
		expect(giftCardStatusText(i18n, 'active')).toBeNull()
		for (const status of [
			'held',
			'frozen',
			'voided',
			'expired',
			'inactive',
			'pending',
		]) {
			expect(giftCardStatusText(i18n, status)).toBeTruthy()
		}
		expect(giftCardUsable('active')).toBe(true)
		for (const status of [
			'held',
			'frozen',
			'voided',
			'expired',
			'inactive',
			'pending',
		]) {
			expect(giftCardUsable(status)).toBe(false)
		}
	})

	it('words every ledger kind that carries money and leaves out the ones that do not', () => {
		const i18n = testI18n('en')
		for (const kind of GIFT_CARD_LEDGER_KINDS) {
			const text = giftCardActivityText(i18n, kind)
			if (kind === 'event') expect(text).toBeNull()
			else expect(text).toBeTruthy()
		}
		expect(giftCardActivityText(i18n, 'something_new')).toBeNull()
	})
})
