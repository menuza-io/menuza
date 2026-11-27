import {
	INVOICE_MAIL_MAX_BYTES,
	inboundMailSchema,
	type InboundMail,
} from '@repo/inventory'
import { readCappedRequestText } from '../lib/http.ts'
import {
	addressIsOnThisNode,
	invoiceCodeFromRecipients,
	invoiceInboxDeps,
	invoiceInboxDomain,
	isInvoiceInboxConfigured,
	isInvoiceWebhookAuthorized,
	type InvoiceAddress,
} from '../lib/invoice-inbox.ts'
import { type MailOutcome } from './inventory-invoice-inbox-service.ts'

/** Base64 and the envelope on top of 25 MB of attachments. */
const MAX_BODY_BYTES = Math.ceil((INVOICE_MAIL_MAX_BYTES * 4) / 3) + 512 * 1024

/**
 * `POST /webhooks/invoice-mail` for the Node runtime and the Workers edge alike
 * (#503): this node's inbound mail provider posts one normalized message
 * (`inboundMailSchema`) with this node's webhook secret as a bearer token.
 *
 * - The recipient must be `invoices+<code>@<INVOICE_INBOX_DOMAIN>`; the code
 *   goes to the control plane (and nothing else does) to learn the
 *   organization, location and data region.
 * - An address of another region is not kept: the mail is dropped here, never
 *   stored, so a KSA location's invoice lives only on the KSA node.
 * - The mail is read in memory, stored in this region's storage and never
 *   logged; answers carry a status word, no mail content.
 * - A provider retry of the same message id is stored once. An email over
 *   25 MB is refused whole (413); a storage outage answers 503 so the provider
 *   tries again.
 */
export async function handleInvoiceMailWebhook(
	request: Request,
	receive: (address: InvoiceAddress, mail: InboundMail) => Promise<MailOutcome>,
): Promise<Response> {
	if (!isInvoiceInboxConfigured()) {
		return Response.json({ error: 'not_configured' }, { status: 503 })
	}
	if (!isInvoiceWebhookAuthorized(request.headers.get('Authorization'))) {
		return Response.json({ error: 'unauthorized' }, { status: 401 })
	}
	const raw = await readCappedRequestText(request, MAX_BODY_BYTES)
	if (raw === null) {
		return Response.json({ status: 'too_large' }, { status: 413 })
	}
	let json: unknown
	try {
		json = JSON.parse(raw)
	} catch {
		return Response.json({ error: 'bad_request' }, { status: 400 })
	}
	const parsed = inboundMailSchema.safeParse(json)
	if (!parsed.success) {
		return Response.json({ error: 'bad_request' }, { status: 400 })
	}
	const mail = parsed.data
	const domain = invoiceInboxDomain()!
	const code = invoiceCodeFromRecipients(mail.to, domain)
	if (!code) {
		return Response.json({ status: 'ignored', reason: 'no_address' })
	}
	const address = await invoiceInboxDeps.lookup(code).catch(() => null)
	if (!address) {
		return Response.json({ status: 'ignored', reason: 'unknown_address' })
	}
	if (!addressIsOnThisNode(address)) {
		return Response.json({ status: 'ignored', reason: 'other_region' })
	}
	const outcome = await receive(address, mail)
	switch (outcome.status) {
		case 'stored':
		case 'duplicate':
			return Response.json({ status: outcome.status, inboxId: outcome.inboxId })
		case 'too_large':
			return Response.json({ status: 'too_large' }, { status: 413 })
		case 'storage_unavailable':
			return Response.json({ status: 'storage_unavailable' }, { status: 503 })
		default:
			return Response.json({ status: 'ignored', reason: outcome.status })
	}
}
