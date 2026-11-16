import { isImpersonating } from '@repo/auth'
import {
	GIFT_CARD_PERMISSIONS,
	type GiftCardFeatures,
	type GiftCardPermission,
} from '@repo/common/gift-cards'
import {
	GIFT_CARD_REPORT_SUBJECTS,
	type GiftCardReportSubject,
} from '@repo/reports/token'
import { resolveDiscountLocationIds } from '#app/utils/discounts/location-scope.server.ts'
import {
	getGiftCardFeatureState,
	getUserGiftCardGrants,
} from './access.server.ts'

/**
 * Which gift card report subjects a person may run, decided on the App and
 * written into the reports token. tenant-api trusts the token and limits every
 * query to the location ids it carries.
 *
 * Rules: an impersonated (support) session gets nothing; the master
 * `gift_cards.enabled` flag must be on; the person needs `read:gift_card:any`;
 * a person limited to selected locations with none selected has no access.
 */
export type GiftCardReportAccess = {
	subjects: GiftCardReportSubject[]
	/** `null` is every location. Always present, never widened by omission. */
	scopeIds: string[] | null
}

const NONE: GiftCardReportAccess = { subjects: [], scopeIds: [] }

export function giftCardReportAccess(input: {
	features: Pick<GiftCardFeatures, 'enabled'>
	held: ReadonlySet<GiftCardPermission>
	locationIds: string[] | null
	impersonated: boolean
}): GiftCardReportAccess {
	if (input.impersonated) return NONE
	if (!input.features.enabled) return NONE
	if (!input.held.has(GIFT_CARD_PERMISSIONS.READ_GIFT_CARD)) return NONE
	if (input.locationIds !== null && input.locationIds.length === 0) return NONE
	return { subjects: [...GIFT_CARD_REPORT_SUBJECTS], scopeIds: input.locationIds }
}

export async function resolveGiftCardReportAccess(input: {
	request: Request
	userId: string
	organizationId: string
}): Promise<GiftCardReportAccess> {
	if (await isImpersonating(input.request)) return NONE
	const features = await getGiftCardFeatureState(input.organizationId)
	if (!features.enabled) return NONE
	const [grants, locationIds] = await Promise.all([
		getUserGiftCardGrants(input.userId, input.organizationId),
		resolveDiscountLocationIds(input.userId, input.organizationId),
	])
	return giftCardReportAccess({
		features,
		held: new Set(grants),
		locationIds,
		impersonated: false,
	})
}
