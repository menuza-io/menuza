import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { fetchNoRedirect } from './fetch-no-redirect.ts'
import { getNodeRegion } from './region.ts'
import {
	getInternalCommandToken,
	getBearerToken,
	syncEnvFromProcess,
	timingSafeEqualString,
} from './secrets.ts'

/**
 * The supplier invoice address (#503): `invoices+<code>@<INVOICE_INBOX_DOMAIN>`.
 * Each data region has its own domain and its own node receives that domain's
 * mail, so a KSA location's invoice reaches only the KSA node and is stored
 * only in KSA storage. The control plane keeps nothing but the location's
 * short code (and answers "which organization and location is this code?",
 * with no mail content).
 */

/** Characters of a location code. */
export const INVOICE_CODE_PATTERN = /^[a-z0-9]{8,24}$/

export function invoiceInboxDomain(): string | null {
	syncEnvFromProcess()
	const raw = (ENV.INVOICE_INBOX_DOMAIN || '').trim().toLowerCase()
	return /^[a-z0-9.-]{3,253}$/.test(raw) ? raw : null
}

/** This node receives invoice mail (a domain and the webhook secret are set). */
export function isInvoiceInboxConfigured(): boolean {
	return invoiceInboxDomain() !== null && invoiceWebhookSecret().length >= 16
}

export function invoiceWebhookSecret(): string {
	syncEnvFromProcess()
	return (ENV.INVOICE_INBOX_WEBHOOK_SECRET || '').trim()
}

/** True when the request carries this node's webhook secret as a bearer token. */
export function isInvoiceWebhookAuthorized(header: string | null | undefined) {
	const secret = invoiceWebhookSecret()
	const presented = getBearerToken(header ?? undefined)
	return (
		secret.length >= 16 &&
		presented !== null &&
		presented !== undefined &&
		timingSafeEqualString(presented, secret)
	)
}

/**
 * The location code in a recipient address, when it is `invoices+<code>@<our
 * domain>` (a display name and case do not matter). Anything else is null.
 */
export function invoiceCodeFromRecipient(
	recipient: string,
	domain: string,
): string | null {
	const address = (/<([^>]+)>/.exec(recipient)?.[1] ?? recipient)
		.trim()
		.toLowerCase()
	const match = /^invoices\+([a-z0-9]+)@(.+)$/.exec(address)
	if (!match || match[2] !== domain) return null
	return INVOICE_CODE_PATTERN.test(match[1]!) ? match[1]! : null
}

/** The first of the recipients that is one of our invoice addresses. */
export function invoiceCodeFromRecipients(
	recipients: readonly string[],
	domain: string,
): string | null {
	for (const recipient of recipients) {
		const code = invoiceCodeFromRecipient(recipient, domain)
		if (code) return code
	}
	return null
}

export const invoiceAddressAnswerSchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	locationId: z.string().min(1).max(100),
	dataRegion: z.enum(['us', 'ksa']),
})
export type InvoiceAddress = z.infer<typeof invoiceAddressAnswerSchema>

async function lookupWithApp(code: string): Promise<InvoiceAddress | null> {
	syncEnvFromProcess()
	const base = (ENV.APP_URL || '').replace(/\/$/, '')
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return null
	const response = await fetchNoRedirect(
		`${base}/resources/inventory/invoice-address?${new URLSearchParams({ code })}`,
		{
			headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(4_000),
		},
	)
	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined)
		return null
	}
	const parsed = invoiceAddressAnswerSchema.safeParse(
		await response.json().catch(() => null),
	)
	return parsed.success ? parsed.data : null
}

/**
 * The seam tests replace: which organization and location a code names. Only
 * the code travels to the control plane, never a byte of the mail.
 */
export const invoiceInboxDeps: {
	lookup: (code: string) => Promise<InvoiceAddress | null>
	now: () => number
} = { lookup: lookupWithApp, now: () => Date.now() }

/** The organization is on this node's region; mail for another region is not kept here. */
export const addressIsOnThisNode = (address: InvoiceAddress): boolean =>
	address.dataRegion === getNodeRegion()
