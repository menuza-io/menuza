import {
	reportGrantsSchema,
	reportRunSpecSchema,
} from '@repo/reports/send-contract'
import { z } from 'zod'
import { hmacHash, timingSafeEqualString } from './secrets.ts'

/**
 * The "Download CSV" link of a scheduled report email (#121). The email
 * sender has no attachment field, so the CSV is a signed link to this node: the
 * token carries what is needed to build the same report again (the report, the
 * instant it was for, the recipient) and an HMAC (`AUTH_HMAC_SECRET`, purpose
 * `report-csv:v1`). Nothing is stored. It is a bearer capability, so it is kept
 * narrow: it lapses after 48 hours, never holds a guest name, phone or email
 * (scheduled reports may not), and the download route asks the App every time
 * whether the recipient may still have it (`report-link-check`), using the
 * recipient's grants of that moment, not those embedded here.
 */

export const REPORT_CSV_PURPOSE = 'report-csv:v1'
export const REPORT_CSV_TTL_MS = 48 * 60 * 60 * 1000
/** A longer token would not survive every mail client; the link is then left out. */
export const REPORT_CSV_MAX_TOKEN_LENGTH = 7_000

const payloadSchema = z.object({
	/** Organization id. */
	o: z.string().min(1).max(64),
	/** The recipient the link was sent to (the App checks them at download). */
	u: z.string().min(1).max(64),
	/** Expiry, ms. */
	exp: z.number().int(),
	/** The send request's report, instant and zone, and the grants at send time. */
	spec: z.object({ req: reportRunSpecSchema, grants: reportGrantsSchema }),
})
export type ReportCsvPayload = z.infer<typeof payloadSchema>

function sign(payloadB64: string) {
	return hmacHash(`${REPORT_CSV_PURPOSE}:${payloadB64}`)
}

/** The signed token, or null when it would be too long for a mail client. */
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
		const parsed = payloadSchema.safeParse(
			JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
		)
		if (!parsed.success) return null
		const { exp } = parsed.data
		// Expired, or signed with a lifetime longer than this node ever issues.
		if (exp < now || exp - now > REPORT_CSV_TTL_MS) return null
		return parsed.data
	} catch {
		return null
	}
}
