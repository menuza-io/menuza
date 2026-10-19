import {
	isValidNormalizedPhone,
	normalizeGuestPhone as normalizeWithRegion,
	type PhoneRegion,
} from '@repo/reservations'
import { getNodeRegion } from './region.ts'

/**
 * The region a number typed without a country code is read in: the data
 * region of this node, which is the region of every org it serves (a region
 * switch wipes the tenant DB). A node without a valid `DATA_REGION` falls
 * back to `us`, the historical behavior.
 */
export function defaultPhoneRegion(): PhoneRegion {
	try {
		return getNodeRegion()
	} catch {
		return 'us'
	}
}

/** Region-aware E.164 normalization; E.164 input is never changed. */
export function normalizeGuestPhone(
	raw: string,
	region: PhoneRegion = defaultPhoneRegion(),
): string {
	return normalizeWithRegion(raw, { region })
}

export {
	isValidNormalizedPhone as isValidPhone,
	isValidNormalizedPhone,
	normalizeGuestPhone as normalizePhone,
}
