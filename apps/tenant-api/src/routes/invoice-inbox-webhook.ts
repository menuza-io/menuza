import { inboundMailSchema } from '@repo/inventory'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { Hono } from 'hono'
import { z } from 'zod'
import { readCappedRequestText } from '../lib/http.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { receiveInvoiceMail } from '../services/inventory-invoice-inbox-service.ts'
import {
	handleInvoiceMailWebhook,
	MAX_BODY_BYTES,
} from '../services/invoice-inbox-webhook.ts'

/**
 * The edge already refused anything over `MAX_BODY_BYTES`, so the hop to the
 * organization's Durable Object takes that plus the small envelope (ids) and no
 * more: the isolate holds the text, its parse and the decoded files at once, so
 * a flat 40 MB would leave too little of its 128 MB.
 */
const RECEIVE_MAX_BYTES = MAX_BODY_BYTES + 64 * 1024

/**
 * Inbound supplier invoice mail (#503). `POST /webhooks/invoice-mail` is the
 * public webhook (Node runtime: it stores the mail in process; the Workers
 * edge answers it itself and forwards to the organization's Durable Object
 * through `/api/invoice-inbox/receive`).
 */
export const invoiceMailWebhookRoutes = new Hono()

invoiceMailWebhookRoutes.post('/', (c) =>
	handleInvoiceMailWebhook(c.req.raw, (address, mail) =>
		receiveInvoiceMail(address.orgId, address.locationId, mail),
	),
)

/** Edge to Durable Object: one organization stores one message. */
export const invoiceInboxInternalRoutes = new Hono()

const receiveSchema = z
	.object({
		orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
		locationId: z.string().min(1).max(100),
		mail: inboundMailSchema,
	})
	.strict()

invoiceInboxInternalRoutes.post('/receive', async (c) => {
	const token = getInternalCommandToken()
	if (token.length < 16) return c.json({ error: 'not_configured' }, 503)
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, token)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	const raw = await readCappedRequestText(c.req.raw, RECEIVE_MAX_BYTES)
	if (raw === null) return c.json({ status: 'too_large' }, 413)
	const parsed = receiveSchema.safeParse(
		(() => {
			try {
				return JSON.parse(raw)
			} catch {
				return null
			}
		})(),
	)
	if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
	return c.json(
		await receiveInvoiceMail(
			parsed.data.orgId,
			parsed.data.locationId,
			parsed.data.mail,
		),
	)
})
