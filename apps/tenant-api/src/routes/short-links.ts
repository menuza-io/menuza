import { Hono } from 'hono'
import { z } from 'zod'
import { isMessageId, isShortLinkCode } from '@repo/common/short-links'
import { getTenantDb, SHORT_LINK_KINDS } from '@repo/tenant-db'
import { errorLogFields } from '../lib/error-log.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	ensureShortLink,
	listShortLinks,
	resolveShortLink,
	setShortLinkState,
	ShortLinkError,
} from '../services/short-links.ts'
import { resolveOrderingOrganization } from './orders.ts'
import { authenticateOperator, requireOperatorClaim } from './operator.ts'

/**
 * Short links (#159). `GET /short-links/resolve` is the public lookup behind
 * `<site>/l/<code>`: Sites asks for it on the server with the site's own
 * `Origin`, and the organization comes from that origin alone. It answers
 * `ok` (with the path to send the visitor to), `disabled` (the site's friendly
 * page) or a uniform 404. Nothing about the visitor is sent, read or stored.
 */
export const publicShortLinkRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const resolveQuery = z.object({
	code: z.string().refine(isShortLinkCode),
	m: z.string().refine(isMessageId).optional(),
	/** `0`: a bot or a visitor over Sites' limit: resolve, do not count. */
	count: z.enum(['0', '1']).optional(),
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
})

publicShortLinkRoutes.get(
	'/resolve',
	rateLimit('short-link-resolve', { windowMs: 60 * 1000, maxRequests: 6000 }),
	async (c) => {
		const parsed = resolveQuery.safeParse(c.req.query())
		if (!parsed.success) return c.json({ status: 'not_found' }, 404, NO_STORE)
		const organization = await resolveOrderingOrganization(c, {
			slug: parsed.data.slug,
			host: parsed.data.host,
		})
		if ('error' in organization) {
			return c.json({ status: 'not_found' }, 404, NO_STORE)
		}
		try {
			const db = await getTenantDb(organization.organization.id)
			const result = await resolveShortLink(db, parsed.data.code, {
				messageId: parsed.data.m,
				count: parsed.data.count !== '0',
			})
			if (result.status === 'not_found') {
				return c.json({ status: 'not_found' }, 404, NO_STORE)
			}
			return c.json(
				result.status === 'ok'
					? { status: 'ok', location: result.location }
					: { status: 'disabled' },
				200,
				NO_STORE,
			)
		} catch (error) {
			console.error('Short link could not be resolved', errorLogFields(error))
			return c.json({ status: 'unavailable' }, 503, NO_STORE)
		}
	},
)

/** `/operator/marketing/short-links`: the Links screen and a print's tracked QR. */
export const shortLinkOperatorRoutes = new Hono()

const createSchema = z
	.object({
		kind: z.enum(['link', 'print']),
		/** A print design id; required for `print`, which is idempotent per design and path. */
		ref: z.string().trim().min(1).max(200).optional(),
		label: z.string().trim().max(120).optional(),
		targetPath: z.string().max(400),
		utmSource: z.string().max(100).optional(),
		utmMedium: z.string().max(100).optional(),
		utmCampaign: z.string().max(100).optional(),
		utmContent: z.string().max(100).optional(),
	})
	.strict()
	.refine((body) => body.kind !== 'print' || Boolean(body.ref), {
		message: 'A print link needs its design',
	})

const patchSchema = z
	.object({
		disabled: z.boolean().optional(),
		label: z.string().trim().max(120).nullable().optional(),
	})
	.strict()

const idsSchema = z.object({
	ids: z.string().max(4000).optional(),
	kind: z.enum(SHORT_LINK_KINDS).optional(),
})

function errorResponse(error: unknown) {
	if (error instanceof ShortLinkError) {
		const status = error.code === 'not_found' ? 404 : 400
		return { body: { error: error.code }, status: status as 400 | 404 }
	}
	return null
}

shortLinkOperatorRoutes.get('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const parsed = idsSchema.safeParse(c.req.query())
	if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
	const ids = parsed.data.ids
		?.split(',')
		.map((id) => id.trim())
		.filter(Boolean)
		.slice(0, 100)
	const db = await getTenantDb(auth.orgId)
	return c.json({
		links: await listShortLinks(db, { kind: parsed.data.kind, ids }),
	})
})

shortLinkOperatorRoutes.post('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? 'invalid_request' },
			400,
		)
	}
	try {
		const db = await getTenantDb(auth.orgId)
		const link = await ensureShortLink(db, parsed.data)
		const [view] = await listShortLinks(db, { ids: [link.id] })
		return c.json({ link: view }, 201)
	} catch (error) {
		const known = errorResponse(error)
		if (known) return c.json(known.body, known.status)
		console.error('Short link could not be created', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

shortLinkOperatorRoutes.patch('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	const parsed = patchSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
	const db = await getTenantDb(auth.orgId)
	if (!(await setShortLinkState(db, c.req.param('id'), parsed.data))) {
		return c.json({ error: 'not_found' }, 404)
	}
	const [view] = await listShortLinks(db, { ids: [c.req.param('id')] })
	return c.json({ link: view })
})
