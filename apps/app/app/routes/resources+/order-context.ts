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

import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
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
}

export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: surface a plain 403 instead of the
		// browser-facing redirect used by human-facing pages.
		if (error instanceof Response && error.status === 302) {
			return new Response('Forbidden', { status: 403 })
		}
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

	const response: OrderContextResponse = {
		orgId: org.id,
		dataRegion,
		menu,
		drop,
		onlinePayment: resolveRestaurantOnlinePayment(org),
	}

	return Response.json(response, {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
