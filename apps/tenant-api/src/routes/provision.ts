import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	TENANT_ORG_ID_PATTERN,
	provisionTenantDb,
	destroyTenantDb,
} from '@repo/tenant-db'

import {
	findActiveOrganizationById,
	organizationFromProvisionPayload,
} from '../lib/origin.ts'
import {
	DEPROVISION_RECORDING_BUDGET_MS,
	deleteOrganizationRecordings,
	type PrefixDeleteResult,
} from '../lib/recording-storage.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'

export const provisionRoutes = new Hono()

// These commands create or remove tenant databases. They are authenticated with
// the internal command token and additionally throttled to limit accidental or
// malicious control-plane retry storms.
provisionRoutes.use(
	'*',
	rateLimit('tenant-provisioning', { windowMs: 60 * 1000, maxRequests: 20 }),
)

const orgIdSchema = z.object({
	orgId: z
		.string()
		.min(1, 'orgId is required')
		.regex(TENANT_ORG_ID_PATTERN, 'Invalid orgId format'),
	slug: z.string().min(1).optional(),
	customDomain: z.string().nullable().optional(),
	dataRegion: z.enum(['us', 'ksa']).optional(),
})

function runInBackground(c: Context, task: Promise<void>) {
	const safeTask = task.catch((error) => {
		console.error('Background recording cleanup failed', error)
	})
	try {
		c.executionCtx.waitUntil(safeTask)
	} catch {
		// Hono throws when there is no execution context (Node), where the
		// long-lived process simply keeps running the task.
	}
}

function unauthorized(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'Provisioning is not configured' }, 503)
	}

	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}

	return null
}

async function runTenantDbCommand(
	c: Context,
	command: 'provision' | 'deprovision',
) {
	const denied = unauthorized(c)
	if (denied) return denied

	const body = await c.req.json().catch(() => ({}))
	const parsed = orgIdSchema.safeParse(body)

	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
			400,
		)
	}

	const { orgId } = parsed.data
	const nodeRegion = getNodeRegion()
	const organization =
		(await findActiveOrganizationById(orgId)) ||
		organizationFromProvisionPayload(parsed.data)

	if (!organization) {
		return c.json({ error: 'Organization not found' }, 404)
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

	try {
		let recordings: PrefixDeleteResult['status'] | undefined
		if (command === 'provision') {
			await provisionTenantDb(orgId)
		} else {
			// Recordings go first: if destroying the database then fails, the
			// command can be retried, but recordings are never left without an org.
			recordings = await deleteOrganizationRecordings(orgId, {
				budgetMs: DEPROVISION_RECORDING_BUDGET_MS,
				runInBackground: (task) => runInBackground(c, task),
			})
			await destroyTenantDb(orgId)
		}
		const verb = command === 'provision' ? 'provisioned' : 'deleted'
		return c.json({
			success: true,
			orgId,
			region: nodeRegion,
			message: `Database ${verb} for tenant ${orgId} in ${nodeRegion}`,
			...(recordings ? { recordings } : {}),
		})
	} catch (error) {
		console.error(`Failed to ${command} DB for ${orgId}:`, error)
		return c.json(
			{
				error:
					command === 'provision'
						? 'Failed to provision tenant database'
						: 'Failed to delete tenant database',
			},
			500,
		)
	}
}

provisionRoutes.post('/provision', (c) => runTenantDbCommand(c, 'provision'))
provisionRoutes.post('/deprovision', (c) =>
	runTenantDbCommand(c, 'deprovision'),
)
