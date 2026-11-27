import { hmacHash, timingSafeEqualString } from './secrets.ts'

/**
 * The "Download CSV" link of a scheduled report email (#121). The email
 * sender has no attachment field, so the CSV is a signed link to this node: the
 * token carries what is needed to build the same report again (the report, the
 * instant it was for, the recipient's grants at send time) and an HMAC
 * (`AUTH_HMAC_SECRET`, purpose `report-csv:v1`). Nothing is stored. It lapses
 * after 7 days, rebuilds the file at download time and never holds a guest
 * name, phone or email (scheduled reports may not). It is a capability for one
 * report, not a login.
 */

export const REPORT_CSV_PURPOSE = 'report-csv:v1'
export const REPORT_CSV_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A longer token would not survive every mail client; the link is then left out. */
export const REPORT_CSV_MAX_TOKEN_LENGTH = 7_000

export type ReportCsvPayload = {
	/** Organization id. */
	o: string
	/** Expiry, ms. */
	exp: number
	/** The send request's report, grants, instant and zone, as the region got them. */
	spec: unknown
}

function sign(payloadB64: string) {
	return hmacHash(`${REPORT_CSV_PURPOSE}:${payloadB64}`)
}

export function signReportCsvToken(payload: ReportCsvPayload): string | null {
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
	const token = `${payloadB64}.${sign(payloadB64)}`
	return token.length > REPORT_CSV_MAX_TOKEN_LENGTH ? null : token
}

export function verifyReportCsvToken(
	token: string,
	now = Date.now(),
): ReportCsvPayload | null {
	if (token.length > REPORT_CSV_MAX_TOKEN_LENGTH) return null
	const [payloadB64, mac, extra] = token.split('.')
	if (!payloadB64 || !mac || extra !== undefined) return null
	let expected: string
	try {
		expected = sign(payloadB64)
	} catch {
		return null
	}
	if (!timingSafeEqualString(mac, expected)) return null
	try {
		const payload = JSON.parse(
			Buffer.from(payloadB64, 'base64url').toString('utf8'),
		) as ReportCsvPayload
		if (
			typeof payload.o !== 'string' ||
			typeof payload.exp !== 'number' ||
			payload.exp < now
		) {
			return null
		}
		return payload
	} catch {
		return null
	}
}
