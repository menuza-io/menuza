import {
	GUEST_PHOTO_MAX_BYTES,
	guestPhotoEligibilityQuerySchema,
	guestPhotoSubmitSchema,
} from '@repo/common/guest-photos'
import { TENANT_ORG_ID_PATTERN, listTenantOrgIds } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	GUEST_PHOTO_OPERATOR_PERMISSION,
	isGuestPhotosKillSwitchOn,
	isOrgGuestPhotosEnabled,
} from '../lib/guest-photo-auth.ts'
import { HttpError, NO_STORE } from '../lib/http.ts'
import { type HeicConverterAdapter } from '../lib/image-reencode.ts'
import { resolveOrganizationFromOrigin } from '../lib/origin.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	checkGuestPhotoEligibility,
	fanOutGuestPhotosTick,
	type GuestPhotoStorageAdapter,
	runGuestPhotosTickForOrg,
	submitGuestPhoto,
	uploadGuestPhoto,
} from '../services/guest-photos-service.ts'
import { authenticateCustomer } from './auth.ts'

export type GuestPhotoRoutesDeps = {
	storage?: GuestPhotoStorageAdapter
	heicConverter?: HeicConverterAdapter
}

type CustomerAuth = Awaited<ReturnType<typeof authenticateCustomer>>

const idFieldSchema = z.string().trim().min(1).max(128)

async function requireCustomerPhotoAccess(
	c: Context,
): Promise<CustomerAuth | Response> {
	if (isGuestPhotosKillSwitchOn()) {
		return c.json({ error: 'guest_photos_unavailable' }, 503, NO_STORE)
	}
	let auth: CustomerAuth
	try {
		auth = await authenticateCustomer(c)
	} catch (response) {
		if (response instanceof Response) return response
		throw response
	}

	const origin = c.req.header('Origin')
	if (origin) {
		const originOrg = await resolveOrganizationFromOrigin(origin)
		if (originOrg && originOrg.id !== auth.orgId) {
			return c.json({ error: 'cross_org_forbidden' }, 403, NO_STORE)
		}
	}

	const enabled = await isOrgGuestPhotosEnabled(
		auth.orgId,
		auth.organization.dataRegion,
	)
	if (!enabled) {
		return c.json({ error: 'guest_photos_disabled' }, 403, NO_STORE)
	}

	return auth
}

function handlePhotoError(c: Context, error: unknown): Response {
	if (error instanceof HttpError) return error.toResponse()
	throw error
}

export function createGuestPhotoRoutes(deps: GuestPhotoRoutesDeps = {}) {
	const routes = new Hono()

	routes.get('/eligibility', async (c) => {
		const auth = await requireCustomerPhotoAccess(c)
		if (auth instanceof Response) return auth

		const parsed = guestPhotoEligibilityQuerySchema.safeParse(c.req.query())
		if (!parsed.success) {
			return c.json({ error: 'validation_error' }, 400, NO_STORE)
		}

		try {
			const eligibility = await checkGuestPhotoEligibility(
				auth.db,
				auth.orgId,
				auth.customerId,
				parsed.data,
			)
			return c.json(eligibility, 200, NO_STORE)
		} catch (error) {
			return handlePhotoError(c, error)
		}
	})

	routes.post('/upload', async (c) => {
		const auth = await requireCustomerPhotoAccess(c)
		if (auth instanceof Response) return auth

		const contentType = c.req.header('Content-Type') ?? ''
		if (!contentType.toLowerCase().includes('multipart/form-data')) {
			return c.json(
				{
					error: 'invalid_content_type',
					message: 'Expected multipart/form-data upload',
				},
				400,
				NO_STORE,
			)
		}

		let formData: FormData
		try {
			formData = await c.req.formData()
		} catch {
			return c.json({ error: 'invalid_multipart_body' }, 400, NO_STORE)
		}

		const orderIdParsed = idFieldSchema.safeParse(formData.get('orderId'))
		const itemIdParsed = idFieldSchema.safeParse(formData.get('itemId'))
		const file = formData.get('file')
		if (
			!orderIdParsed.success ||
			!itemIdParsed.success ||
			!file ||
			typeof file === 'string' ||
			typeof file.arrayBuffer !== 'function'
		) {
			return c.json({ error: 'validation_error' }, 400, NO_STORE)
		}

		if (file.size <= 0) {
			return c.json({ error: 'file_empty' }, 400, NO_STORE)
		}
		if (file.size > GUEST_PHOTO_MAX_BYTES) {
			return c.json({ error: 'file_too_large' }, 413, NO_STORE)
		}

		const rawBytes = new Uint8Array(await file.arrayBuffer())
		try {
			const uploaded = await uploadGuestPhoto(
				auth.db,
				auth.orgId,
				auth.customerId,
				{
					orderId: orderIdParsed.data,
					itemId: itemIdParsed.data,
					rawBytes,
				},
				{
					storage: deps.storage,
					heicConverter: deps.heicConverter,
				},
			)
			return c.json(uploaded, 201, NO_STORE)
		} catch (error) {
			return handlePhotoError(c, error)
		}
	})

	routes.post('/', async (c) => {
		const auth = await requireCustomerPhotoAccess(c)
		if (auth instanceof Response) return auth

		const body = await c.req.json().catch(() => null)
		const parsed = guestPhotoSubmitSchema.safeParse(body)
		if (!parsed.success) {
			return c.json({ error: 'validation_error' }, 400, NO_STORE)
		}

		try {
			const submission = await submitGuestPhoto(
				auth.db,
				auth.orgId,
				auth.customerId,
				parsed.data,
				{ storage: deps.storage },
			)
			return c.json({ submission }, 201, NO_STORE)
		} catch (error) {
			return handlePhotoError(c, error)
		}
	})

	return routes
}

export const guestPhotoRoutes = createGuestPhotoRoutes()

// ---------------------------------------------------------------------------
// Internal regional tick for 30-day rejected photo purge
// ---------------------------------------------------------------------------

const tickBodySchema = z
	.object({
		orgId: z
			.string()
			.regex(TENANT_ORG_ID_PATTERN, 'Invalid orgId format')
			.optional(),
	})
	.strict()

function checkTickAuth(c: Context): Response | null {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'service_unavailable' }, 503, NO_STORE)
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'unauthorized' }, 401, NO_STORE)
	}
	return null
}

export const guestPhotoTickRoutes = new Hono()

guestPhotoTickRoutes.use(
	'*',
	rateLimit('guest-photos-tick', { windowMs: 60 * 1000, maxRequests: 60 }),
)

guestPhotoTickRoutes.post('/tick', async (c) => {
	const denied = checkTickAuth(c)
	if (denied) return denied
	const body = await c.req.json().catch(() => ({}))
	const parsed = tickBodySchema.safeParse(body ?? {})
	if (!parsed.success) {
		return c.json({ error: 'validation_error' }, 400, NO_STORE)
	}
	if (parsed.data.orgId) {
		const result = await runGuestPhotosTickForOrg(parsed.data.orgId)
		return c.json({ success: result.errors === 0, result }, 200, NO_STORE)
	}
	const totals = await fanOutGuestPhotosTick({
		orgIds: await listTenantOrgIds(),
	})
	return c.json({ success: totals.errors === 0, ...totals }, 200, NO_STORE)
})

// Re-export for route-wiring convenience.
export { GUEST_PHOTO_OPERATOR_PERMISSION }
