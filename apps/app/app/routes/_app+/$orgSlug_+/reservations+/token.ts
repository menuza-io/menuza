import { isImpersonating } from '@repo/auth'
import {
	RESERVATIONS_PERMISSIONS as P,
	reservationsScopeSchema,
	type ReservationsFeature,
	type ReservationsPermission,
	type ReservationsScope,
} from '@repo/reservations'
import { data, type LoaderFunctionArgs } from 'react-router'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { mintReservationsToken } from '#app/utils/reservations/token.server.ts'

const SCOPE_REQUIREMENTS: Record<
	ReservationsScope,
	{
		feature: ReservationsFeature
		anyOf: readonly ReservationsPermission[]
	}
> = {
	book: {
		feature: 'enabled',
		anyOf: [P.READ_RESERVATION, P.UPDATE_RESERVATION, P.READ_RESERVATION_GUEST],
	},
	guests: {
		feature: 'enabled',
		anyOf: [P.READ_RESERVATION_GUEST, P.UPDATE_RESERVATION_GUEST],
	},
	setup: {
		feature: 'enabled',
		anyOf: [
			P.READ_RESERVATION_SETTINGS,
			P.UPDATE_RESERVATION_SETTINGS,
			P.READ_RESERVATION,
		],
	},
	reports: {
		feature: 'enabled',
		anyOf: [P.READ_RESERVATION_REPORT],
	},
	payments: {
		feature: 'payments',
		anyOf: [P.READ_RESERVATION_REPORT, P.UPDATE_RESERVATION_PAYMENT],
	},
}

/**
 * Credentials for browser-direct reservations calls:
 * `GET /:orgSlug/reservations/token?scope=<book|guests|setup|reports|payments>`
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const rawScope = new URL(request.url).searchParams.get('scope') ?? 'book'
	const parsedScope = reservationsScopeSchema.safeParse(rawScope)
	if (!parsedScope.success) {
		throw data({ error: 'Unknown reservations scope' }, { status: 400 })
	}
	const scope = parsedScope.data
	const requirement = SCOPE_REQUIREMENTS[scope]

	const access = await requireReservationsAccess(request, params.orgSlug, {
		feature: requirement.feature,
		anyOf: requirement.anyOf,
	})
	const impersonated = await isImpersonating(request)
	const minted = await mintReservationsToken({
		organizationId: access.organizationId,
		userId: access.userId,
		dataRegion: access.dataRegion,
		scope,
		grants: access.grants,
		locationIds: access.locationIds,
		features: access.features,
		impersonated,
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
		{
			headers: {
				'Cache-Control': 'private, no-store',
			},
		},
	)
}
