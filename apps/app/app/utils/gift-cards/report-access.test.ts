import { GIFT_CARD_PERMISSIONS, type GiftCardPermission } from '@repo/common/gift-cards'
import { describe, expect, it } from 'vitest'
import { giftCardReportAccess } from './report-access.server.ts'

const READ = new Set([GIFT_CARD_PERMISSIONS.READ_GIFT_CARD])
const on = { enabled: true }

describe('giftCardReportAccess', () => {
	it('lists the four subjects for a reader with the flag on', () => {
		const access = giftCardReportAccess({ features: on, held: READ, locationIds: null, impersonated: false })
		expect(access.subjects).toEqual([
			'gift_card_sales',
			'gift_card_redemptions',
			'gift_card_balances',
			'gift_card_settlement',
		])
		expect(access.scopeIds).toBeNull()
	})
	it('carries the person’s locations and never widens by omission', () => {
		const access = giftCardReportAccess({ features: on, held: READ, locationIds: ['a'], impersonated: false })
		expect(access.scopeIds).toEqual(['a'])
	})
	it('gives nothing without the flag, without the grant, impersonating, or with no locations', () => {
		const none = { subjects: [], scopeIds: [] }
		expect(giftCardReportAccess({ features: { enabled: false }, held: READ, locationIds: null, impersonated: false })).toEqual(none)
		expect(giftCardReportAccess({ features: on, held: new Set<GiftCardPermission>(), locationIds: null, impersonated: false })).toEqual(none)
		expect(giftCardReportAccess({ features: on, held: READ, locationIds: null, impersonated: true })).toEqual(none)
		expect(giftCardReportAccess({ features: on, held: READ, locationIds: [], impersonated: false })).toEqual(none)
	})
})
