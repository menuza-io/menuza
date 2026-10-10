import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { z } from 'zod'

import {
	createJourneySchema,
	updateJourneySchema,
	executeStepPayloadSchema,
	completeRunPayloadSchema,
	evaluateConditionPayloadSchema,
} from '@repo/tenant-db'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	getOperatorToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	executeJourneyStep,
	evaluateJourneyCondition,
	completeJourneyRun,
	getJourneyDefinition,
	listJourneys,
	createJourney,
	updateJourney,
	publishJourney,
	pauseJourney,
	deleteJourney,
	listJourneyRuns,
	getJourneyRunTimeline,
	triggerTestJourney,
} from '../services/journey-service.ts'
import { brand } from '@repo/config/brand'

// =========================================================================
// 1. SYSTEM-TO-SYSTEM JOURNEY ROUTES (/api/journeys/*)
// Authenticated via Bearer INTERNAL_COMMAND_TOKEN using constant-time check
// =========================================================================

export const journeySystemRoutes = new Hono()

function checkSystemAuth(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'System API is not configured' }, 503)
	}

	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}

	return null
}

const getDefinitionQuerySchema = z.object({
	orgId: z.string().min(1, 'orgId query parameter is required'),
})

async function assertOrgRegion(c: Context, orgId: string) {
	const nodeRegion = getNodeRegion()
	const organization = await findActiveOrganizationById(orgId)

	if (!organization) {
		return c.json(
			{
				error: 'organization_not_found',
				message:
					'Organization could not be resolved; refusing to execute outside a verified region',
			},
			404,
		)
	}

	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return c.json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${nodeRegion}")`,
				orgRegion: organization.dataRegion,
				nodeRegion,
			},
			409,
		)
	}

	return null
}

journeySystemRoutes.post('/execute-step', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied

	const body = await c.req.json().catch(() => ({}))
	const parsed = executeStepPayloadSchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{
				error: 'Invalid execute step payload',
				issues: parsed.error.issues,
			},
			400,
		)
	}

	const { orgId } = parsed.data
	const regionDenied = await assertOrgRegion(c, orgId)
	if (regionDenied) return regionDenied

	const result = await executeJourneyStep(orgId, parsed.data)

	if (!result.success) {
		const statusCode = (result.statusCode || 500) as any
		return c.json(
			{
				error: result.error || 'Step execution failed',
				executionId: result.executionId,
				status: result.status,
			},
			statusCode,
		)
	}

	return c.json({
		success: true,
		executionId: result.executionId,
		status: result.status,
		messageId: result.messageId,
	})
})

journeySystemRoutes.post('/evaluate-condition', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied

	const body = await c.req.json().catch(() => ({}))
	const parsed = evaluateConditionPayloadSchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{
				error: 'Invalid evaluate condition payload',
				issues: parsed.error.issues,
			},
			400,
		)
	}

	const regionDenied = await assertOrgRegion(c, parsed.data.orgId)
	if (regionDenied) return regionDenied

	const result = await evaluateJourneyCondition(parsed.data.orgId, parsed.data)

	if (!result.success) {
		const statusCode = (result.statusCode || 500) as any
		return c.json({ error: result.error }, statusCode)
	}

	return c.json(result)
})

journeySystemRoutes.post('/complete-run', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied

	const body = await c.req.json().catch(() => ({}))
	const parsed = completeRunPayloadSchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{
				error: 'Invalid complete run payload',
				issues: parsed.error.issues,
			},
			400,
		)
	}

	const regionDenied = await assertOrgRegion(c, parsed.data.orgId)
	if (regionDenied) return regionDenied

	const result = await completeJourneyRun(parsed.data.orgId, parsed.data)

	if (!result.success) {
		const statusCode = (result.statusCode || 500) as any
		return c.json({ error: result.error }, statusCode)
	}

	return c.json(result)
})

journeySystemRoutes.get('/definitions/:journeyId', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied

	const journeyId = c.req.param('journeyId')
	const query = getDefinitionQuerySchema.safeParse(c.req.query())

	if (!query.success) {
		return c.json(
			{
				error: 'Missing required orgId query parameter',
				issues: query.error.issues,
			},
			400,
		)
	}

	const result = await getJourneyDefinition(query.data.orgId, journeyId)

	if (!result.success) {
		const statusCode = (result.statusCode || 500) as any
		return c.json({ error: result.error }, statusCode)
	}

	return c.json(result)
})

// =========================================================================
// 2. OPERATOR JOURNEY MANAGEMENT ROUTES (/operator/journeys/*)
// Authenticated via Operator JWT minted with audience: 'tenant-api-operator'
// =========================================================================

export const journeyOperatorRoutes = new Hono()

export async function authenticateOperator(c: Context) {
	const token = getBearerToken(c.req.header('Authorization')) || null
	if (!token) {
		throw c.json({ error: 'Unauthorized' }, 401)
	}

	const operatorToken = getOperatorToken()
	if (operatorToken.length < 16) {
		throw c.json({ error: 'Not configured' }, 503)
	}

	let decoded: { orgId: string; role: string }
	try {
		const secret = new TextEncoder().encode(operatorToken)
		const { payload } = await jwtVerify(token, secret, {
			audience: 'tenant-api-operator',
			issuer: brand.shortName,
			algorithms: ['HS256'],
		})
		decoded = payload as typeof decoded
	} catch {
		throw c.json({ error: 'Invalid or expired operator token' }, 401)
	}

	if (decoded.role !== 'operator') {
		throw c.json({ error: 'Invalid role' }, 403)
	}

	return decoded
}

const triggerTestSchema = z.object({
	journeyId: z.string().min(1, 'journeyId is required'),
	customerId: z.string().min(1, 'customerId is required'),
})

journeyOperatorRoutes.get('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	try {
		const result = await listJourneys(auth.orgId)
		return c.json(result)
	} catch (error) {
		console.error('Error listing journeys:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

journeyOperatorRoutes.post('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const body = await c.req.json().catch(() => ({}))
	const parsed = createJourneySchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{ error: 'Invalid journey payload', issues: parsed.error.issues },
			400,
		)
	}

	try {
		const result = await createJourney(auth.orgId, parsed.data)
		if (!result.success) {
			const statusCode = (result.statusCode || 400) as any
			return c.json({ error: result.error, issues: result.issues }, statusCode)
		}
		return c.json(result, 201)
	} catch (error) {
		console.error('Error creating journey:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

journeyOperatorRoutes.get('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const journeyId = c.req.param('id')
	try {
		const result = await getJourneyDefinition(auth.orgId, journeyId)
		if (!result.success) {
			const statusCode = (result.statusCode || 404) as any
			return c.json({ error: result.error }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error retrieving journey:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

journeyOperatorRoutes.patch('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const journeyId = c.req.param('id')
	const body = await c.req.json().catch(() => ({}))
	const parsed = updateJourneySchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{ error: 'Invalid update payload', issues: parsed.error.issues },
			400,
		)
	}

	try {
		const result = await updateJourney(auth.orgId, journeyId, parsed.data)
		if (!result.success) {
			const statusCode = (result.statusCode || 400) as any
			return c.json({ error: result.error, issues: result.issues }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error updating journey:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

journeyOperatorRoutes.put('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const journeyId = c.req.param('id')
	const body = await c.req.json().catch(() => ({}))
	const parsed = updateJourneySchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{ error: 'Invalid update payload', issues: parsed.error.issues },
			400,
		)
	}

	try {
		const result = await updateJourney(auth.orgId, journeyId, parsed.data)
		if (!result.success) {
			const statusCode = (result.statusCode || 400) as any
			return c.json({ error: result.error, issues: result.issues }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error updating journey:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

journeyOperatorRoutes.post('/:id/publish', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const journeyId = c.req.param('id')
	try {
		const result = await publishJourney(auth.orgId, journeyId)
		if (!result.success) {
			const statusCode = (result.statusCode || 400) as any
			return c.json({ error: result.error, issues: result.issues }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error publishing journey:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

journeyOperatorRoutes.post('/:id/pause', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const journeyId = c.req.param('id')
	try {
		const result = await pauseJourney(auth.orgId, journeyId)
		if (!result.success) {
			const statusCode = (result.statusCode || 404) as any
			return c.json({ error: result.error }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error pausing journey:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

journeyOperatorRoutes.delete('/:id', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const journeyId = c.req.param('id')
	try {
		const result = await deleteJourney(auth.orgId, journeyId)
		if (!result.success) {
			const statusCode = (result.statusCode || 404) as any
			return c.json({ error: result.error }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error deleting journey:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

journeyOperatorRoutes.get('/:id/runs', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const journeyId = c.req.param('id')
	try {
		const result = await listJourneyRuns(auth.orgId, journeyId)
		return c.json(result)
	} catch (error) {
		console.error('Error listing journey runs:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

journeyOperatorRoutes.get('/runs/:runId', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const runId = c.req.param('runId')
	try {
		const result = await getJourneyRunTimeline(auth.orgId, runId)
		if (!result.success) {
			const statusCode = (result.statusCode || 404) as any
			return c.json({ error: result.error }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error getting run timeline:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

journeyOperatorRoutes.post('/trigger-test', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const body = await c.req.json().catch(() => ({}))
	const parsed = triggerTestSchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{ error: 'Invalid test trigger payload', issues: parsed.error.issues },
			400,
		)
	}

	try {
		const result = await triggerTestJourney(auth.orgId, parsed.data)
		if (!result.success) {
			const statusCode = (result.statusCode || 400) as any
			return c.json({ error: result.error }, statusCode)
		}
		return c.json(result)
	} catch (error) {
		console.error('Error triggering test journey:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})
