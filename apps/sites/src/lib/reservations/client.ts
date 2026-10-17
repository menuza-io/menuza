import { createReservationsApi } from './api.ts'
import { type ReservationLabels } from './labels.ts'
import {
	clearSessionTokens,
	getAccessToken,
	getBrowserTenantApiUrl,
	tenantFetch,
} from '~/lib/client-auth'

/** The reservations client for this page: browser-direct to the regional tenant-api. */
export function createBrowserReservationsApi() {
	return createReservationsApi({
		baseUrl: getBrowserTenantApiUrl(),
		authedFetch: tenantFetch,
		isSignedIn: () => Boolean(getAccessToken()),
		clearSession: clearSessionTokens,
	})
}

export function readReservationLabels(): ReservationLabels {
	const node = document.getElementById('reservation-labels')
	try {
		return JSON.parse(node?.textContent || '{}') as ReservationLabels
	} catch {
		return {} as ReservationLabels
	}
}

/** Name and phone from the signed-in customer's profile, or `null` for a guest. */
export async function loadCustomerPrefill(): Promise<{
	name: string
	phone: string
	email: string
} | null> {
	if (!getAccessToken()) return null
	try {
		const res = await tenantFetch('/auth/me')
		if (!res.ok) return null
		const data = (await res.json()) as {
			customer?: { name?: string; email?: string; phone?: string }
		}
		const customer = data.customer
		if (!customer) return null
		return {
			name: customer.name ?? '',
			phone: customer.phone ?? '',
			email: customer.email ?? '',
		}
	} catch {
		return null
	}
}
