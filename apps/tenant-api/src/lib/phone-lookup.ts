import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * What the text provider says about a phone number (#246): is it a real
 * number, is it a mobile, a landline or a virtual line, and which carrier.
 * Behind a small adapter so tests and local runs never call the provider.
 */
export type NumberLookup = {
	valid: boolean
	lineType: 'mobile' | 'landline' | 'voip' | 'unknown'
	carrier: string | null
}

export type LookupFetch = typeof fetch

function isExplicitLocalRuntime() {
	syncEnvFromProcess()
	return ENV.NODE_ENV === 'development' || ENV.NODE_ENV === 'test'
}

function classify(type: unknown): NumberLookup['lineType'] {
	const value = typeof type === 'string' ? type.toLowerCase() : ''
	if (value === 'mobile') return 'mobile'
	if (value === 'landline' || value === 'fixedvoip' || value === 'fixed_line') {
		return value === 'fixedvoip' ? 'voip' : 'landline'
	}
	if (value.includes('voip')) return 'voip'
	return 'unknown'
}

/** Deterministic emulator for local runs: the last digits decide. */
export function mockLookup(e164: string): NumberLookup {
	if (e164.endsWith('9999'))
		return { valid: false, lineType: 'unknown', carrier: null }
	if (e164.endsWith('0000'))
		return { valid: true, lineType: 'landline', carrier: 'Mock Telecom' }
	if (e164.endsWith('7777'))
		return { valid: true, lineType: 'voip', carrier: 'Mock VoIP' }
	return { valid: true, lineType: 'mobile', carrier: 'Mock Mobile' }
}

/**
 * Twilio Lookup v2 with line type intelligence. A missing number is `valid:
 * false`. Returns null when the provider cannot be reached or is not set up, so
 * the caller can say "could not check" instead of guessing.
 */
export async function lookupNumber(
	e164: string,
	fetchImpl: LookupFetch = fetch,
): Promise<NumberLookup | null> {
	syncEnvFromProcess()
	const sid = ENV.TWILIO_ACCOUNT_SID as string | undefined
	const token = ENV.TWILIO_AUTH_TOKEN as string | undefined
	if (!sid || !token) {
		return isExplicitLocalRuntime() ? mockLookup(e164) : null
	}
	try {
		const response = await fetchImpl(
			`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
			{
				headers: {
					Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
				},
				signal: AbortSignal.timeout(10_000),
			},
		)
		if (response.status === 404) {
			return { valid: false, lineType: 'unknown', carrier: null }
		}
		if (!response.ok) return null
		const body = (await response.json()) as {
			valid?: unknown
			line_type_intelligence?: { type?: unknown; carrier_name?: unknown } | null
		}
		const intelligence = body.line_type_intelligence
		return {
			valid: body.valid === true,
			lineType: classify(intelligence?.type),
			carrier:
				typeof intelligence?.carrier_name === 'string'
					? intelligence.carrier_name.slice(0, 80)
					: null,
		}
	} catch {
		return null
	}
}
