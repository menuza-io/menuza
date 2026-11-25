/**
 * Internal (regional tenant service) order context for restaurant ordering.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` — never public. Serves the
 * authoritative, KV-bypassed public catalog the regional service needs to
 * revalidate a restaurant order before writing it: org routing flags, the
 * location-priced menu, an optional published drop, and whether online
 * payment is enabled and on which processor.
 *
 * Only non-PII catalog data is returned. Draft drops are never leaked: a
 * draft or missing drop comes back as `null` and the regional service must
 * refuse orders against it.
 */

import { type AlcoholContext } from '@repo/common/alcohol-rules'
import { type DailyDishLimitsContext } from '@repo/common/daily-dish-limits'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { type LargeOrderAlertRule } from '@repo/common/operator-alerts'
import {
	foldQrOrderingFeatures,
	QR_ORDERING_FLAG_KEYS,
	type QrOrderingFeatures,
} from '@repo/common/qr-ordering'
import {
	type GuestCancelContext,
	type OrderAcceptanceContext,
} from '@repo/common/restaurant-orders'
import { and, db, eq, Organization } from '@repo/database'
import { type OrderContextDiscounts } from '@repo/discounts'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { buildLargeOrderAlertContext } from '#app/utils/alerts/large-order.server.ts'
import { buildOrderContextDiscounts } from '#app/utils/discounts/order-context.server.ts'
import {
	buildGuestMessagesContext,
	buildLargeOrderContext,
} from '#app/utils/guest-messages/settings.server.ts'
import {
	type GuestMessagesContext,
	type LargeOrderContext,
} from '#app/utils/guest-messages/settings.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	buildPublicSiteDropPayload,
	type PublicSiteDropPayload,
} from '#app/utils/menu/public-drop-context.server.ts'
import {
	buildPublicSiteMenuPayload,
	type PublicSiteMenuPayload,
} from '#app/utils/menu/public-menu-context.server.ts'
import {
	buildPickupInstructionsContext,
	buildUtensilsContext,
} from '#app/utils/orders/checkout-extras.server.ts'
import { buildAlcoholContext } from '#app/utils/orders/alcohol-context.server.ts'
import { buildDailyDishLimitsContext } from '#app/utils/orders/daily-dish-limits.server.ts'
import { buildOrderCapsContext } from '#app/utils/orders/order-caps.server.ts'
import { buildOrderPolicyContext } from '#app/utils/orders/order-policies.server.ts'
import {
	buildPackagingFeeContext,
	type PackagingFeeContext,
} from '#app/utils/orders/packaging-fee.server.ts'
import {
	buildServiceFeeContext,
	type ServiceFeeContext,
} from '#app/utils/orders/service-fee.server.ts'
import {
	buildSlotLimitsContext,
	type SlotLimitsContext,
} from '#app/utils/orders/slot-limits.server.ts'
import {
	resolveRestaurantOnlinePayment,
	type RestaurantOnlinePayment,
} from '#app/utils/restaurant-orders/payment-config.server.ts'

const querySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	locationId: z.string().optional(),
	drop: z.string().trim().toLowerCase().optional(),
})

export type OrderContextResponse = {
	orgId: string
	dataRegion: 'us' | 'ksa'
	menu: PublicSiteMenuPayload
	drop: PublicSiteDropPayload | null
	onlinePayment: RestaurantOnlinePayment
	/** QR ordering flags; the region treats anything missing as off. */
	qrOrdering: QrOrderingFeatures
	/**
	 * Active discounts and their codes. `menu` items and variants carry
	 * `excludeFromDiscounts` (`menu.categories[].items[]` and `.variations.variants[]`
	 * as built by `serializePublicMenuItem`). The region reads a missing field as off.
	 */
	discounts: OrderContextDiscounts
	/** Guest transactional order messages: the org flag and the operator switches. */
	guestMessages: GuestMessagesContext
	/**
	 * Large-order extra prep per location id; only locations that have a
	 * threshold. `threshold` is in MAJOR currency units for `amount` (as stored,
	 * 100 is 100.00) and an item count for `items`.
	 */
	largeOrder: LargeOrderContext
	/**
	 * The large-order alert threshold per location id (#300); only locations that
	 * turned the alert on, only while manager alerts are on. A missing location
	 * flags nothing.
	 */
	largeOrderAlert: Record<string, LargeOrderAlertRule>
	/**
	 * Guest self-cancel per location id (`ordering.guest_cancel`): only while
	 * the flag is on, only locations that offer a window. The region reads a
	 * missing location as off.
	 */
	guestCancel: GuestCancelContext
	/**
	 * Manual order acceptance per location id (`ordering.manual_acceptance`):
	 * only while the flag is on, only `manual` locations. The region reads a
	 * missing location as Automatic.
	 */
	acceptance: OrderAcceptanceContext
	/**
	 * The guest service fee per location id (`ordering.service_fee`, #123):
	 * only while the flag is on, only locations whose fee is on. The region
	 * refuses orders at a listed location whose fee it cannot read.
	 */
	serviceFee: ServiceFeeContext
	packagingFee: PackagingFeeContext
	orderCaps: { locations: Record<string, unknown> }
	/** Where alcohol may be ordered online (#167). */
	alcohol: AlcoholContext
	pickupInstructions: Record<string, string>
	utensils: Awaited<ReturnType<typeof buildUtensilsContext>>
	slotLimits: SlotLimitsContext
	dailyDishLimits: DailyDishLimitsContext
}

async function readQrOrderingFeatures(
	organizationId: string,
): Promise<QrOrderingFeatures> {
	const [enabled, dineIn, online] = await Promise.all([
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.dineIn, { organizationId }),
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.online, { organizationId }),
	])
	return foldQrOrderingFeatures({ enabled, dineIn, online })
}

export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: the 401 from internal auth is the answer.
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid parameters' }, { status: 400 })
	}

	// Active, published, provisioned organizations only: the regional service
	// cannot accept orders for an org without a regional database.
	const org = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, parsed.data.orgId),
			eq(Organization.active, true),
			eq(Organization.sitePublished, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: {
			id: true,
			name: true,
			slug: true,
			dataRegion: true,
			siteDefaultLocale: true,
			siteLocales: true,
			customDomain: true,
			shopPaymentProvider: true,
			stripeConnectAccountId: true,
			stripeConnectChargesEnabled: true,
			checkoutSubEntityId: true,
			checkoutChargesEnabled: true,
		},
	})

	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	const dataRegion: 'us' | 'ksa' =
		(org.dataRegion || 'us').toLowerCase() === 'ksa' ? 'ksa' : 'us'
	const currency = dataRegion === 'ksa' ? 'SAR' : 'USD'

	// Fresh authoritative menu pricing — never the published KV cache.
	const { payload: menu } = await buildPublicSiteMenuPayload(
		{
			id: org.id,
			name: org.name,
			slug: org.slug,
			currency,
			siteDefaultLocale: org.siteDefaultLocale,
			siteLocales: org.siteLocales,
			customDomain: org.customDomain,
		},
		parsed.data.locationId ?? null,
	)

	// Optional drop context. Drafts are never leaked to the regional service;
	// a missing or unpublished drop yields null and the caller must reject
	// orders that reference it.
	let drop: PublicSiteDropPayload | null = null
	if (parsed.data.drop) {
		const dropPayload = await buildPublicSiteDropPayload(
			{ id: org.id, name: org.name, slug: org.slug, currency },
			parsed.data.drop,
		)
		drop =
			dropPayload && dropPayload.drop.status !== 'draft' ? dropPayload : null
	}

	const orderPolicies = await buildOrderPolicyContext(
		org.id,
		parsed.data.locationId ?? null,
	)

	const response: OrderContextResponse = {
		orgId: org.id,
		dataRegion,
		menu,
		drop,
		onlinePayment: resolveRestaurantOnlinePayment(org),
		qrOrdering: await readQrOrderingFeatures(org.id),
		discounts: await buildOrderContextDiscounts(org.id),
		guestMessages: await buildGuestMessagesContext(org.id),
		largeOrder: await buildLargeOrderContext(
			org.id,
			parsed.data.locationId ?? null,
		),
		largeOrderAlert: await buildLargeOrderAlertContext(
			org.id,
			parsed.data.locationId ?? null,
		),
		guestCancel: orderPolicies.guestCancel,
		acceptance: orderPolicies.acceptance,
		serviceFee: await buildServiceFeeContext(
			org.id,
			parsed.data.locationId ?? null,
		),
		packagingFee: await buildPackagingFeeContext(
			org.id,
			parsed.data.locationId ?? null,
		),
		orderCaps: await buildOrderCapsContext(
			org.id,
			parsed.data.locationId ?? null,
		),
		alcohol: await buildAlcoholContext(
			org.id,
			dataRegion,
			parsed.data.locationId ?? null,
		),
		pickupInstructions: await buildPickupInstructionsContext(
			org.id,
			parsed.data.locationId ?? null,
		),
		utensils: await buildUtensilsContext(
			org.id,
			parsed.data.locationId ?? null,
		),
		slotLimits: await buildSlotLimitsContext(org.id),
		dailyDishLimits: await buildDailyDishLimitsContext(org.id),
	}

	return Response.json(response, {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
