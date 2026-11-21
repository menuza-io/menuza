import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { listTenantOrgIds, TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { applyInboundSmsForOrg } from '../services/sms-inbound.ts'
import { handleInboundSmsWebhook } from '../services/sms-inbound-webhook.ts'

/**
 * Inbound text replies (#75). `POST /webhooks/sms/:provider` is the public
 * webhook (Node runtime: it applies the keyword to every organization in
 * process; the Workers edge answers it itself and forwards to each
 * organization's Durable Object through `/api/sms-inbound/apply`).
 */
export const smsWebhookRoutes = new Hono()

smsWebhookRoutes.post('/:provider', (c) =>
	handleInboundSmsWebhook(c.req.raw, c.req.param('provider'), async () => ({
		orgIds: await listTenantOrgIds(),
		applyToOrg: applyInboundSmsForOrg,
	})),
)

/** Edge to Durable Object: one organization applies one keyword. */
export const smsInboundInternalRoutes = new Hono()

const applySchema = z
	.object({
		orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
		providerMessageId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
		from: z.string().regex(/^\+?[0-9]{6,20}$/),
		keyword: z.enum(['stop', 'start', 'help']),
	})
	.strict()

function unauthorized(c: Context) {
	const token = getInternalCommandToken()
	if (token.length < 16) return c.json({ error: 'not_configured' }, 503)
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, token)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	return null
}

smsInboundInternalRoutes.post('/apply', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied
	const parsed = applySchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
	const { orgId, ...input } = parsed.data
	return c.json(await applyInboundSmsForOrg(orgId, input))
})
