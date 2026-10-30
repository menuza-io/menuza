import { Platform } from 'react-native'
import { LoyaltyStore } from '../loyalty/loyalty-store'
import {
	ReservationsClient,
	type ReservationsClientPlatform,
} from '../reservations/reservations-client'
import { ReservationsStore } from '../reservations/reservations-store'
import {
	createSecureReservationTokenStore,
	type ReservationTokenStore,
} from '../reservations/token-store'
import { type FeatureContext } from '../state/app-store'

/** The signed-in customer's features; recreated per organization and session. */
export type AppFeatures = {
	readonly reservations: ReservationsStore
	readonly loyalty: LoyaltyStore
}

/** What tenant-api records as the channel (`native` for both). */
export function nativeClientPlatform(): ReservationsClientPlatform {
	return Platform.OS === 'android' ? 'android' : 'ios'
}

export type CustomerFeatureOptions = {
	/** Loyalty learned the session is dead (revoked, another organization): sign out app-wide. */
	readonly onSessionEnded?: () => void
	/** Test seam; defaults to secure storage keyed by the organization. */
	readonly reservationTokens?: (orgId: string) => ReservationTokenStore
}

export function createCustomerFeatures(
	context: FeatureContext,
	options: CustomerFeatureOptions = {},
): AppFeatures {
	const platform = nativeClientPlatform()
	return {
		reservations: new ReservationsStore({
			client: new ReservationsClient(context.session, { platform }),
			tokens: (
				options.reservationTokens ?? createSecureReservationTokenStore
			)(context.organization.id),
			localeCode: context.language().code,
		}),
		loyalty: new LoyaltyStore({
			session: context.session,
			platform,
			onSessionEnded: options.onSessionEnded,
		}),
	}
}
