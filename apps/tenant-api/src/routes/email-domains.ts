import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import {
	dkimSelectorFor,
	getEmailDomainProvider,
	type EmailDomainRecord,
} from '@repo/email'
import {
	isValidSenderDomain,
	isValidSenderLocalPart,
} from '@repo/common/email-sender'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'

/**
 * Sending domains of this node's region (#103), for the App. The OCI
 * credentials of a region live on its node, so the App asks the node to
 * register, check and remove an organization's domain at the region's email
 * provider. Authenticated with the internal command token. DNS records and
 * a provider reference only: no guest data crosses here.
 */
export const emailDomainRoutes = new Hono()

emailDomainRoutes.use(
	'*',
	rateLimit('email-domains', { windowMs: 60 * 1000, maxRequests: 60 }),
)

function denied(c: Context) {
	const token = getInternalCommandToken()
	if (token.length < 16) return c.json({ error: 'Not configured' }, 503)
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, token)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	return null
}

const orgId = z.string().regex(TENANT_ORG_ID_PATTERN)

const registerSchema = z.object({
	orgId,
	domain: z.string().max(253).refine(isValidSenderDomain),
	localPart: z.string().max(64).refine(isValidSenderLocalPart),
})

const recordSchema = z.object({
	purpose: z.enum(['spf', 'dkim', 'return_path', 'dmarc']),
	type: z.enum(['TXT', 'CNAME', 'MX']),
	name: z.string().max(253),
	value: z.string().max(2048),
	priority: z.number().int().optional(),
	required: z.boolean(),
}) satisfies z.ZodType<EmailDomainRecord>

const checkSchema = z.object({
	providerRef: z.string().min(1).max(256),
	domain: z.string().max(253).refine(isValidSenderDomain),
	records: z.array(recordSchema).max(10),
})

emailDomainRoutes.post('/email-domains/register', async (c) => {
	const refused = denied(c)
	if (refused) return refused
	const parsed = registerSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'invalid_body' }, 422)
	const provider = getEmailDomainProvider()
	if (!provider.isConfigured())
		return c.json({ error: 'email_not_configured' }, 503)
	try {
		const result = await provider.register({
			domain: parsed.data.domain,
			localPart: parsed.data.localPart,
			selector: dkimSelectorFor(parsed.data.orgId),
			organizationId: parsed.data.orgId,
		})
		return c.json(result)
	} catch (error) {
		console.error('Registering a sending domain failed', {
			orgId: parsed.data.orgId,
			reason: error instanceof Error ? error.name : 'unknown',
		})
		return c.json({ error: 'provider_failed' }, 502)
	}
})

emailDomainRoutes.post('/email-domains/check', async (c) => {
	const refused = denied(c)
	if (refused) return refused
	const parsed = checkSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'invalid_body' }, 422)
	try {
		return c.json(await getEmailDomainProvider().check(parsed.data))
	} catch {
		return c.json({ error: 'provider_failed' }, 502)
	}
})

emailDomainRoutes.post('/email-domains/remove', async (c) => {
	const refused = denied(c)
	if (refused) return refused
	const parsed = z
		.object({ providerRef: z.string().min(1).max(256) })
		.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'invalid_body' }, 422)
	await getEmailDomainProvider()
		.remove(parsed.data.providerRef)
		.catch(() => undefined)
	return c.json({ ok: true })
})
