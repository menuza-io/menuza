import { userHasOrganizationPermission } from '@repo/auth'
import { type PrintQrTarget } from '@repo/common/print-shop'
import { type RestaurantCouponTarget } from '@repo/common/print-shop-restaurant'
import { getDiscountsFeatures } from '#app/utils/discounts/access.server.ts'
import {
	getDiscount,
	listDiscounts,
} from '#app/utils/discounts/discounts.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { getPrintShopFeatures, type PrintShopAccess } from '../access.server.ts'
import {
	type PrintQrTargetServer,
	type PrintScope,
} from '../vertical-contract.server.ts'
import {
	couponCopy,
	isPrintableOffer,
	type CouponOffer,
} from './coupon-copy.ts'

/**
 * The coupon QR target: a discount from Discounts printed on a card, flyer
 * or poster. A code discount prints its code and a QR to
 * `/menu?coupon=CODE`, which Sites keeps like a typed code; an automatic one
 * prints a QR to the menu, where the offer shows. Only offers a customer can
 * use through that QR are offered: active, online (`web` channel), not a
 * till-only manual discount, and not ended.
 */

type Access = Pick<PrintShopAccess, 'userId' | 'organization'>

/**
 * A code is a way to a discount, so the proof, download and order need the
 * discounts read permission and the feature on, whoever approved the print.
 * The marketing permissions alone never reach it.
 */
export async function canPrintCoupons(access: Access) {
	const features = await getDiscountsFeatures(access.organization.id)
	if (!features.enabled) return false
	return userHasOrganizationPermission(
		access.userId,
		access.organization.id,
		ORG_PERMISSIONS.READ_DISCOUNT_ANY,
	)
}

export function isCouponTarget(
	target: PrintQrTarget,
): target is PrintQrTarget & RestaurantCouponTarget {
	return (
		target.kind === 'coupon' &&
		typeof target.discountId === 'string' &&
		(target.codeId === null || typeof target.codeId === 'string')
	)
}

type DiscountRecord = NonNullable<Awaited<ReturnType<typeof getDiscount>>>

function fallbackCurrency(access: Access) {
	return access.organization.dataRegion === 'ksa' ? 'SAR' : 'USD'
}

function offerOf(
	found: DiscountRecord,
	access: Access,
	scopes: PrintScope[],
): CouponOffer | null {
	if (!found.stored || found.row.status !== 'active') return null
	const { definition } = found.stored
	const only =
		definition.locationIds?.length === 1 && scopes.length > 1
			? (scopes.find((scope) => scope.id === definition.locationIds![0])
					?.name ?? null)
			: null
	return {
		name: definition.name,
		application: definition.application,
		valueType: definition.valueType,
		percentBp: definition.percentBp,
		amountMinor: definition.amountMinor,
		hasTiers: Boolean(definition.tiers),
		minSubtotalMinor: definition.minSubtotalMinor,
		startsAt: definition.startsAt,
		endsAt: definition.endsAt,
		eligibility: definition.eligibility,
		perCustomerLimit: definition.perCustomerLimit,
		fulfillments: definition.fulfillments,
		channels: definition.channels,
		currency: definition.currency ?? fallbackCurrency(access),
		onlyLocationName: only,
	}
}

/** The discount and the code a target prints, or null when it cannot print now. */
async function loadPrintable(
	access: Access,
	target: RestaurantCouponTarget,
	scopes: () => Promise<PrintScope[]>,
) {
	const found = await getDiscount(access.organization.id, target.discountId)
	if (!found) return null
	const offer = offerOf(found, access, await scopes())
	if (!offer || !isPrintableOffer(offer)) return null
	if (offer.application !== 'code') return { found, offer, code: null }
	const code = found.codes.find((entry) => entry.id === target.codeId)
	return code ? { found, offer, code } : null
}

export type CouponEditorData = {
	discounts: Array<{
		id: string
		name: string
		application: 'code' | 'automatic'
		codes: Array<{ id: string; code: string }>
		/** The discount's page, where its uses per code are counted. */
		href: string
	}>
	/** How many active discounts were left out (till-only, ended, offline). */
	hidden: number
	newHref: string
}

async function printableDiscounts(access: Access) {
	const all = await listDiscounts(access.organization.id)
	const active = all.filter(
		(discount) => discount.status === 'active' && discount.definition,
	)
	const printable = active.filter((discount) => {
		const definition = discount.definition!
		if (definition.application === 'code' && discount.codes.length === 0) {
			return false
		}
		return isPrintableOffer(definition)
	})
	return { printable, hidden: active.length - printable.length }
}

export function couponTarget(input: {
	scopes: (organizationId: string) => Promise<PrintScope[]>
	siteUrl: (
		origin: string,
		path: string,
		params: Record<string, string>,
	) => string
}): PrintQrTargetServer {
	const scopesOf = (access: Access) => () =>
		input.scopes(access.organization.id)
	return {
		available: canPrintCoupons,
		canView: canPrintCoupons,
		// A coupon card starts on the most recently changed offer; any print
		// opened from a discount ("Print" on its page) starts on that one.
		defaultFor: async (access, { product, ref }) => {
			if (!ref && product.key !== 'coupon_card') return null
			if (!(await canPrintCoupons(access))) return null
			const { printable } = await printableDiscounts(access)
			const discount = ref
				? printable.find((entry) => entry.id === ref)
				: printable[0]
			if (!discount) return null
			return {
				kind: 'coupon',
				discountId: discount.id,
				codeId:
					discount.definition!.application === 'code'
						? (discount.codes[0]?.id ?? null)
						: null,
			}
		},
		editorData: async (_request, access): Promise<CouponEditorData> => {
			const slug = access.organization.slug
			const { printable, hidden } = await printableDiscounts(access)
			return {
				discounts: printable.map((discount) => ({
					id: discount.id,
					name: discount.name,
					application:
						discount.definition!.application === 'code' ? 'code' : 'automatic',
					codes: discount.codes.map((code) => ({
						id: code.id,
						code: code.code,
					})),
					href: `/${slug}/discounts/${discount.id}`,
				})),
				hidden,
				newHref: `/${slug}/discounts/new`,
			}
		},
		defaultCopy: async (target, locale, access) => {
			if (!isCouponTarget(target)) return null
			const printable = await loadPrintable(access, target, scopesOf(access))
			return printable ? couponCopy(printable.offer, locale) : null
		},
		fromForm: (formData) => {
			const discountId = String(formData.get('couponDiscountId') ?? '')
			if (!discountId) return 'empty'
			return {
				kind: 'coupon',
				discountId,
				codeId: String(formData.get('couponCodeId') ?? '') || null,
			}
		},
		resolve: async (target, { access, siteOrigin, utm }) => {
			if (!isCouponTarget(target)) return { pieces: [], facts: [] }
			if (!(await canPrintCoupons(access))) {
				throw new Response('Forbidden', { status: 403 })
			}
			// Gone, paused, archived, ended, moved off the web or its code
			// removed: nothing to print, so approval is refused and an approved
			// print goes stale.
			const printable = await loadPrintable(access, target, scopesOf(access))
			if (!printable) return { pieces: [], facts: [] }
			const { found, code } = printable
			const locationIds = found.stored!.definition.locationIds
			return {
				pieces: [
					{
						label: code?.code ?? null,
						// One location: open its menu, where the code works.
						qrUrl: input.siteUrl(siteOrigin, '/menu', {
							...(locationIds?.length === 1
								? { location: locationIds[0]! }
								: {}),
							...(code ? { coupon: code.code } : {}),
							...utm,
						}),
					},
				],
				facts: [
					{
						id: code ? `code:${code.id}` : `discount:${found.row.id}`,
						label: code?.code ?? found.row.name,
						// A reissued code is a new row; the discount version covers
						// the rest (a changed offer prints a different promise).
						version: found.row.version,
					},
				],
			}
		},
	}
}

/**
 * "Print" on a discount's page: a new coupon card that starts on this
 * discount, or null when the Print shop is off, the user cannot design
 * prints, or the offer cannot be used through a printed QR right now.
 */
export async function couponPrintHref(input: {
	userId: string
	organization: { id: string; slug: string }
	discount: {
		id: string
		status: string
		definition: Pick<CouponOffer, 'application' | 'channels' | 'endsAt'>
		codeCount: number
	}
}): Promise<string | null> {
	const { discount } = input
	if (discount.status !== 'active') return null
	if (!isPrintableOffer(discount.definition)) return null
	if (discount.definition.application === 'code' && discount.codeCount === 0) {
		return null
	}
	const features = await getPrintShopFeatures(input.organization.id)
	if (!features.enabled) return null
	const canDesign = await userHasOrganizationPermission(
		input.userId,
		input.organization.id,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)
	if (!canDesign) return null
	const params = new URLSearchParams({
		product: 'coupon_card',
		start: `coupon:${discount.id}`,
	})
	return `/${input.organization.slug}/marketing/print/new?${params}`
}
