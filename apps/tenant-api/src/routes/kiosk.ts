import { type Context, Hono, type Next } from 'hono'
import {
	kioskIdentifySchema,
	kioskPairSchema,
	kioskPunchSchema,
} from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { findActiveOrganizationById } from '../lib/origin.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { getBearerToken } from '../lib/secrets.ts'
import { parseDeviceToken } from '../lib/staff-pin.ts'
import {
	databaseUnavailable,
	invalid,
	noStoreHeaders,
	readJson,
	staffingSwitchEnabled,
} from '../lib/staffing-auth.ts'
import {
	identifyAtKiosk,
	type KioskContext,
	kioskDeviceView,
	loadKioskDevice,
	pairKiosk,
	punchAtKiosk,
} from '../services/staffing-kiosk.ts'

type KioskEnv = { Variables: { kiosk: KioskContext } }

/**
 * Public routes for a paired shared tablet. There is no operator session: the
 * device token (shown once at pairing) authenticates the device and a PIN
 * identifies the person. The App flag cannot reach a paired device, so the
 * node kill switch and per-device revoke are the off switches.
 */
export const kioskRoutes = new Hono<KioskEnv>()

function fail(
	c: Context,
	status: 400 | 401 | 404 | 409 | 423 | 503,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return c.json({ error, ...extra }, status, noStoreHeaders)
}

kioskRoutes.use('*', async (c, next) => {
	if (!staffingSwitchEnabled('STAFFING_KIOSK_ENABLED')) {
		return fail(c, 503, 'kiosk_disabled')
	}
	await next()
})

const pairRateLimit = rateLimit('kiosk-pair', {
	windowMs: 15 * 60 * 1000,
	maxRequests: 10,
})
const identifyRateLimit = rateLimit('kiosk-identify', {
	windowMs: 60 * 1000,
	maxRequests: 20,
})
const kioskRateLimit = rateLimit('kiosk', {
	windowMs: 60 * 1000,
	maxRequests: 60,
})

async function organizationReady(orgId: string) {
	const organization = await findActiveOrganizationById(orgId)
	return Boolean(
		organization &&
		organization.hasProvisionedDb &&
		orgMatchesNodeRegion(organization.dataRegion),
	)
}

async function requireDevice(c: Context<KioskEnv>, next: Next) {
	const token = getBearerToken(c.req.header('Authorization'))
	const parsed = token ? parseDeviceToken(token) : null
	if (!parsed) return fail(c, 401, 'device_unpaired')
	try {
		if (!(await organizationReady(parsed.orgId))) {
			return fail(c, 401, 'device_unpaired')
		}
		const device = await loadKioskDevice(parsed.orgId, token)
		if (!device) return fail(c, 401, 'device_unpaired')
		c.set('kiosk', { orgId: parsed.orgId, device })
	} catch (error) {
		return databaseUnavailable(c, parsed.orgId, error)
	}
	await next()
}

kioskRoutes.post('/pair', pairRateLimit, async (c) => {
	const parsed = kioskPairSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	const { orgId, code } = parsed.data
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return fail(c, 400, 'invalid_code')
	try {
		if (!(await organizationReady(orgId))) return fail(c, 400, 'invalid_code')
		const result = await pairKiosk(orgId, code)
		if (!result.ok) return fail(c, 400, result.code)
		return c.json(result.data, 200, noStoreHeaders)
	} catch (error) {
		return databaseUnavailable(c, orgId, error)
	}
})

kioskRoutes.get('/device', kioskRateLimit, requireDevice, (c) =>
	c.json(
		{ device: kioskDeviceView(c.get('kiosk').device) },
		200,
		noStoreHeaders,
	),
)

kioskRoutes.post('/identify', identifyRateLimit, requireDevice, async (c) => {
	const parsed = kioskIdentifySchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	const context = c.get('kiosk')
	try {
		const result = await identifyAtKiosk(context, parsed.data.pin)
		if (result.ok) return c.json(result.data, 200, noStoreHeaders)
		if (result.code === 'locked') {
			c.header('Retry-After', String(result.retryAfterSeconds))
			return fail(c, 423, 'locked', {
				retryAfterSeconds: result.retryAfterSeconds,
			})
		}
		return fail(c, 401, 'invalid_pin', {
			remainingAttempts: result.remainingAttempts,
		})
	} catch (error) {
		return databaseUnavailable(c, context.orgId, error)
	}
})

kioskRoutes.post('/punch', kioskRateLimit, requireDevice, async (c) => {
	const parsed = kioskPunchSchema.safeParse(await readJson(c))
	if (!parsed.success) return invalid(c, parsed.error)
	const context = c.get('kiosk')
	try {
		const result = await punchAtKiosk(context, parsed.data)
		if (!result.ok) return fail(c, result.status, result.code)
		return c.json(result.data, 200, noStoreHeaders)
	} catch (error) {
		return databaseUnavailable(c, context.orgId, error)
	}
})
