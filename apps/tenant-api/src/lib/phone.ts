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
 * digits without the `+`, and the region's national forms. Only the erasure
 * path uses it, to find every row a number could be stored in. Never use it to
 * look up a customer to sign in as: a short E.164 could claim another number's
 * national-form row (see `findCustomerByPhone`).
 */
export function legacyPhoneForms(
	e164: string,
	region: PhoneRegion = defaultPhoneRegion(),
): string[] {
	if (!isValidE164Phone(e164)) return []
	const digits = e164.slice(1)
	const forms = new Set<string>([digits])
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
