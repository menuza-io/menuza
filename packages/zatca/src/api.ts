import { type ZatcaEnvironment } from './csr.ts'
import { toBase64 } from './crypto.ts'

/**
 * Fatoora (ZATCA e-invoicing) API, version 2. Server-side only: it needs the
 * CSID secrets, which never reach a till. `fetch` is injectable for tests.
 */

export const FATOORA_BASE_URL: Record<ZatcaEnvironment, string> = {
	sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
	simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
	production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
}

export type Csid = {
	/** The certificate, base64 encoded once more (as ZATCA returns it). */
	binarySecurityToken: string
	secret: string
	requestId: string
}

export type FatooraResult<T> =
	| { ok: true; value: T; status: number }
	/** `retry`: the request may succeed later (network, 5xx, rate limit); otherwise ZATCA refused it. */
	| { ok: false; status: number; retry: boolean; error: string; body: unknown }

type Fetch = typeof fetch

const basic = (token: string, secret: string) =>
	`Basic ${toBase64(new TextEncoder().encode(`${token}:${secret}`))}`

async function call<T>(
	fetcher: Fetch,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	read: (json: Record<string, unknown>, status: number) => T,
): Promise<FatooraResult<T>> {
	let response: Response
	try {
		response = await fetcher(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Accept-Language': 'en',
				'Accept-Version': 'V2',
				'Content-Type': 'application/json',
				...headers,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		})
	} catch (error) {
		return {
			ok: false,
			status: 0,
			retry: true,
			error: error instanceof Error ? error.message : 'network error',
			body: null,
		}
	}
	const json = ((await response.json().catch(() => null)) ?? {}) as Record<
		string,
		unknown
	>
	// 200: accepted. 202: accepted with warnings (reporting). Anything 4xx except 429 is a refusal.
	if (response.status === 200 || response.status === 202)
		return {
			ok: true,
			status: response.status,
			value: read(json, response.status),
		}
	const retry =
		response.status === 429 || response.status >= 500 || response.status === 401
	return {
		ok: false,
		status: response.status,
		retry,
		error: summarizeErrors(json) ?? `HTTP ${response.status}`,
		body: json,
	}
}

/** The first error ZATCA gives, in a line. */
export function summarizeErrors(json: unknown): string | null {
	const body = json as {
		validationResults?: {
			errorMessages?: Array<{ code?: string; message?: string }>
		}
		errors?: Array<{ code?: string; message?: string } | string>
		message?: string
	}
	const first =
		body?.validationResults?.errorMessages?.[0] ??
		(Array.isArray(body?.errors) ? body.errors[0] : undefined) ??
		(body?.message ? { message: body.message } : undefined)
	if (!first) return null
	if (typeof first === 'string') return first
	return [first.code, first.message].filter(Boolean).join(': ') || null
}

const readCsid = (json: Record<string, unknown>): Csid => ({
	binarySecurityToken: String(json.binarySecurityToken ?? ''),
	secret: String(json.secret ?? ''),
	requestId: String(json.requestID ?? json.requestId ?? ''),
})

export function fatooraClient(
	environment: ZatcaEnvironment,
	fetcher: Fetch = fetch,
) {
	const base = FATOORA_BASE_URL[environment]
	return {
		/** Step 1: the compliance CSID, from the CSR and the one-time password from the Fatoora portal. */
		complianceCsid: (csrBase64Pem: string, otp: string) =>
			call(
				fetcher,
				`${base}/compliance`,
				{ OTP: otp },
				{ csr: csrBase64Pem },
				readCsid,
			),

		/** Step 2: each required sample document, signed with the compliance certificate. */
		complianceCheck: (
			csid: Csid,
			document: { invoiceHash: string; uuid: string; xmlBase64: string },
		) =>
			call(
				fetcher,
				`${base}/compliance/invoices`,
				{ Authorization: basic(csid.binarySecurityToken, csid.secret) },
				{
					invoiceHash: document.invoiceHash,
					uuid: document.uuid,
					invoice: document.xmlBase64,
				},
				(json) => json,
			),

		/** Step 3: the production CSID, once the compliance checks pass. */
		productionCsid: (compliance: Csid) =>
			call(
				fetcher,
				`${base}/production/csids`,
				{
					Authorization: basic(
						compliance.binarySecurityToken,
						compliance.secret,
					),
				},
				{ compliance_request_id: compliance.requestId },
				readCsid,
			),

		/** Reports a simplified document (within 24 hours of issuing it). */
		report: (
			production: Csid,
			document: { invoiceHash: string; uuid: string; xmlBase64: string },
		) =>
			call(
				fetcher,
				`${base}/invoices/reporting/single`,
				{
					Authorization: basic(
						production.binarySecurityToken,
						production.secret,
					),
					'Clearance-Status': '0',
				},
				{
					invoiceHash: document.invoiceHash,
					uuid: document.uuid,
					invoice: document.xmlBase64,
				},
				(json) => json,
			),
	}
}
