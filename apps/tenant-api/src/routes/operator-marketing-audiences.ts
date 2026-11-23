import {
	AUDIENCE_LIMITS,
	audienceDefinitionSchema,
	namesSensitiveRule,
	saveAudienceSchema,
	type AudienceErrorCode,
} from '@repo/common/marketing-audiences'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { z } from 'zod'
import { errorLogFields } from '../lib/error-log.ts'
import {
	audienceUsage,
	countAudience,
	createAudience,
	deleteAudience,
	getAudience,
	listAudiences,
	updateAudience,
} from '../services/marketing-audience-service.ts'
import { audienceOutOfScope } from '../services/marketing-audience-rules.ts'
import { authenticateOperator, requireOperatorClaim } from './operator.ts'

/**
 * Saved audiences (#98), `/operator/marketing/audiences`. The App's server
 * calls these with its operator token; every answer is a definition, a count or
 * an id, never a guest. Counts under 5 come back `null` ("fewer than 5").
 */
export const marketingAudienceRoutes = new Hono()

const STATUS: Record<AudienceErrorCode, 400 | 403 | 404 | 409 | 422> = {
	audience_not_found: 404,
	audience_in_use: 409,
	audience_limit: 409,
	audience_name_taken: 409,
	audience_version_changed: 409,
	invalid_audience: 400,
	sensitive_rule_not_allowed: 422,
	location_out_of_scope: 403,
}

const idSchema = z.string().min(1).max(100)

async function readBody(c: import('hono').Context) {
	try {
		return { ok: true as const, body: (await c.req.json()) as unknown }
	} catch {
		return { ok: false as const }
	}
}

/** Sensitive fields first (their own code), then the shape. Never echoes a value. */
function refuse(code: AudienceErrorCode, c: import('hono').Context) {
	return c.json({ error: code }, STATUS[code])
}

marketingAudienceRoutes.get('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	try {
		const db = await getTenantDb(auth.orgId)
		const audiences = await listAudiences(db)
		const withCounts = c.req.query('counts') !== '0'
		const items = await Promise.all(
			audiences.map(async (audience) => ({
				...audience,
				counts: withCounts
					? await countAudience(db, audience.definition)
					: null,
			})),
		)
		return c.json({ audiences: items, limits: AUDIENCE_LIMITS })
	} catch (error) {
		console.error('Audiences could not be listed', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

marketingAudienceRoutes.post('/preview', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const read = await readBody(c)
	if (!read.ok) return refuse('invalid_audience', c)
	const raw = (read.body as { definition?: unknown } | null)?.definition
	if (namesSensitiveRule(raw)) return refuse('sensitive_rule_not_allowed', c)
	const parsed = audienceDefinitionSchema.safeParse(raw)
	if (!parsed.success) return refuse('invalid_audience', c)
	if (audienceOutOfScope(parsed.data, auth.locationIds)) {
		return refuse('location_out_of_scope', c)
	}
	try {
		const db = await getTenantDb(auth.orgId)
		return c.json({ counts: await countAudience(db, parsed.data) })
	} catch (error) {
		console.error('Audience preview failed', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

marketingAudienceRoutes.post('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	const read = await readBody(c)
	if (!read.ok) return refuse('invalid_audience', c)
	if (namesSensitiveRule(read.body))
		return refuse('sensitive_rule_not_allowed', c)
	const parsed = saveAudienceSchema.safeParse(read.body)
	if (!parsed.success) return refuse('invalid_audience', c)
	if (audienceOutOfScope(parsed.data.definition, auth.locationIds)) {
		return refuse('location_out_of_scope', c)
	}
	try {
		const db = await getTenantDb(auth.orgId)
		const result = await createAudience(db, {
			name: parsed.data.name,
			definition: parsed.data.definition,
			createdBy: auth.sub,
		})
		if (!result.ok) return refuse(result.error, c)
		return c.json({ audience: result.value }, 201)
	} catch (error) {
		console.error('Audience could not be created', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

marketingAudienceRoutes.get('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const id = idSchema.safeParse(c.req.param('id'))
	if (!id.success) return refuse('audience_not_found', c)
	try {
		const db = await getTenantDb(auth.orgId)
		const audience = await getAudience(db, id.data)
		if (!audience) return refuse('audience_not_found', c)
		const [counts, usage] = await Promise.all([
			countAudience(db, audience.definition),
			audienceUsage(db, id.data),
		])
		return c.json({ audience, counts, usage })
	} catch (error) {
		console.error('Audience could not be read', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

marketingAudienceRoutes.put('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	const id = idSchema.safeParse(c.req.param('id'))
	if (!id.success) return refuse('audience_not_found', c)
	const read = await readBody(c)
	if (!read.ok) return refuse('invalid_audience', c)
	if (namesSensitiveRule(read.body))
		return refuse('sensitive_rule_not_allowed', c)
	const parsed = saveAudienceSchema.safeParse(read.body)
	if (!parsed.success) return refuse('invalid_audience', c)
	if (audienceOutOfScope(parsed.data.definition, auth.locationIds)) {
		return refuse('location_out_of_scope', c)
	}
	try {
		const db = await getTenantDb(auth.orgId)
		const result = await updateAudience(db, id.data, parsed.data)
		if (!result.ok) return refuse(result.error, c)
		return c.json({ audience: result.value })
	} catch (error) {
		console.error('Audience could not be saved', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

marketingAudienceRoutes.delete('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canDelete')
	if (denied) return denied
	const id = idSchema.safeParse(c.req.param('id'))
	if (!id.success) return refuse('audience_not_found', c)
	try {
		const db = await getTenantDb(auth.orgId)
		const result = await deleteAudience(db, id.data)
		if (!result.ok) {
			if (result.error === 'audience_in_use') {
				return c.json(
					{ error: 'audience_in_use', usage: await audienceUsage(db, id.data) },
					409,
				)
			}
			return refuse(result.error, c)
		}
		return c.json({ success: true })
	} catch (error) {
		console.error('Audience could not be deleted', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})
