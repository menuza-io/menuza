import {
	isValidE164Phone,
	normalizePhone as normalizeWithRegion,
	type PhoneRegion,
} from '@repo/common/phone'
import { getNodeRegion } from './region.ts'

/**
 * The region a number typed without a country code is read in: the data
 * region of this node, which is the region of every org it serves (a region
 * switch wipes the tenant DB). A node without a valid `DATA_REGION` falls
 * back to `us`.
 */
export function defaultPhoneRegion(): PhoneRegion {
	try {
		return getNodeRegion()
	} catch {
		return 'us'
	}
}

/** Region-aware E.164 normalization; E.164 input is never changed. */
export function normalizePhone(
	raw: string,
	region: PhoneRegion = defaultPhoneRegion(),
): string {
	return normalizeWithRegion(raw, { region })
}

export { isValidE164Phone as isValidPhone }

/**
 * Forms a number may have been stored in before E.164 normalization: the
 * digits without the `+`, and the region's national forms. Used only to find
 * an existing customer (never to write); the row is rewritten to E.164 on a
 * successful sign-in. The E.164 form itself is not included.
 */
export function legacyPhoneForms(
	e164: string,
	region: PhoneRegion = defaultPhoneRegion(),
): string[] {
	if (!isValidE164Phone(e164)) return []
	const digits = e164.slice(1)
	const forms = new Set<string>()
	// The bare digits are ambiguous when they look like this region's national
	// number: a row stored as `5551234567` is the US national form of
	// +15551234567, so the different E.164 +5551234567 must not claim it (that
	// would text a stranger's number and sign them in as that customer).
	const readsAsNationalNumber =
		(region === 'us' && /^[2-9]\d{9}$/.test(digits)) ||
		(region === 'ksa' && /^5\d{8}$/.test(digits))
	if (!readsAsNationalNumber) forms.add(digits)
	if (region === 'ksa' && /^9665\d{8}$/.test(digits)) {
		forms.add(`0${digits.slice(3)}`)
		forms.add(digits.slice(3))
	}
	if (region === 'us' && /^1[2-9]\d{9}$/.test(digits)) {
		forms.add(digits.slice(1))
	}
	forms.delete(e164)
	return [...forms]
}
