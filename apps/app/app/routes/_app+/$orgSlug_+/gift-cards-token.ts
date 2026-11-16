import {
	GIFT_CARD_PERMISSIONS as P,
	GIFT_CARD_SCOPES,
	type GiftCardPermission,
	type GiftCardScope,
} from '@repo/common/gift-cards'
import { data, type LoaderFunctionArgs } from 'react-router'
import { requireGiftCardAccess } from '#app/utils/gift-cards/access.server.ts'
import { mintGiftCardToken } from '#app/utils/gift-cards/token.server.ts'

const SCOPE_REQUIREMENTS: Record<GiftCardScope, readonly GiftCardPermission[]> = {
	read: [P.READ_GIFT_CARD],
	write: [P.UPDATE_GIFT_CARD, P.UPDATE_GIFT_CARD_CHARGE],
}

/**
 * Credentials for browser-direct gift card calls:
 * `GET /:orgSlug/gift-cards-token?scope=<read|write>`. Support impersonation
 * gets read grants only and a shorter token.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const rawScope = new URL(request.url).searchParams.get('scope') ?? 'read'
	const scope = (GIFT_CARD_SCOPES as readonly string[]).includes(rawScope)
		? (rawScope as GiftCardScope)
		: null
	const access = await requireGiftCardAccess(request, params.orgSlug, {
		anyOf: SCOPE_REQUIREMENTS[scope ?? 'read'],
	})
	if (!scope) {
		throw data({ error: 'Unknown gift card scope' }, { status: 400 })
	}
	const minted = await mintGiftCardToken({
		organizationId: access.organizationId,
		userId: access.userId,
		actorName: access.userName,
		dataRegion: access.dataRegion,
		scope,
		grants: access.grants,
		locationIds: access.locationIds,
		features: access.features,
		impersonated: access.impersonated,
	})
	return data(
		{
			jwt: minted.jwt,
			tenantApiUrl: minted.tenantApiUrl,
			scope: minted.scope,
			grants: minted.grants,
			locationIds: minted.locationIds,
			features: minted.features,
			expiresAt: minted.expiresAt,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
