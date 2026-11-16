import {
	type EmailCouponCopy,
	type EmailRenderContext,
} from '@repo/common/email-block-base'
import {
	couponButtonLabel,
	emailDirectionFor,
} from '@repo/common/email-blocks-restaurant'
import { db, eq, Organization } from '@repo/database'
import { type MarketingOffer } from '@repo/discounts'
import { ENV } from 'varlock/env'
import { getDiscount } from '#app/utils/discounts/discounts.server.ts'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { couponCopy } from '#app/utils/print/restaurant/coupon-copy.ts'
import { couponOfferFromDiscount } from '#app/utils/print/restaurant/coupon.server.ts'

/**
 * What an email render needs besides the blocks (#153): the site language and
 * direction, the organization's own site origin for Order and coupon links, the
 * image-transform host, and the words of the coupon the message carries.
 *
 * The coupon's words come from `couponCopy` (the print shop's builder), so an
 * offer reads the same on a card and in an email. Control-plane data only.
 */
export async function loadEmailRenderContext(input: {
	organizationId: string
	offer: MarketingOffer | null
}): Promise<EmailRenderContext> {
	const [org] = await db
		.select({
			slug: Organization.slug,
			customDomain: Organization.customDomain,
			siteDefaultLocale: Organization.siteDefaultLocale,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	if (!org) return {}
	const locale = org.siteDefaultLocale || 'en'

	let coupon: EmailCouponCopy | null = null
	if (input.offer) {
		const found = await getDiscount(
			input.organizationId,
			input.offer.discountId,
		)
		const offer = found
			? couponOfferFromDiscount(found, org.dataRegion === 'ksa' ? 'SAR' : 'USD')
			: null
		if (offer) {
			const copy = couponCopy(offer, locale)
			coupon = {
				headline: copy.headline,
				terms: copy.body,
				buttonLabel: couponButtonLabel(locale),
			}
		}
	}

	return {
		direction: emailDirectionFor(locale),
		locale,
		siteOrigin: orgSiteUrl(org),
		imageTransformBase:
			(
				ENV as { MEDIA_TRANSFORM_BASE_URL?: string }
			).MEDIA_TRANSFORM_BASE_URL?.trim() || null,
		coupon,
	}
}
