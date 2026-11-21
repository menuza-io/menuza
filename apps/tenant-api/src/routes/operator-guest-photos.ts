import {
	guestPhotoDecisionSchema,
	guestPhotoListQuerySchema,
	guestPhotoMarkAddedSchema,
} from '@repo/common/guest-photos'
import { getTenantDb } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	checkGuestPhotoOperatorAccess,
	isGuestPhotosKillSwitchOn,
	verifyGuestPhotoOperatorToken,
	type GuestPhotoOperatorContext,
} from '../lib/guest-photo-auth.ts'
import { HttpError, NO_STORE } from '../lib/http.ts'
import {
	decideGuestPhoto,
	getApprovedGuestPhotoSignedUrl,
	getOperatorGuestPhoto,
	type GuestPhotoStorageAdapter,
	listOperatorGuestPhotos,
	markGuestPhotoAdded,
	removeGuestPhotoAdded,
} from '../services/guest-photos-service.ts'

export type OperatorGuestPhotoRoutesDeps = {
	storage?: GuestPhotoStorageAdapter
}

const idSchema = z.string().trim().min(1).max(128)

async function requireOperatorPhotoAccess(
	c: Context,
	requireWrite: boolean,
): Promise<
	| {
			ctx: GuestPhotoOperatorContext
			db: Awaited<ReturnType<typeof getTenantDb>>
	  }
	| Response
> {
	if (isGuestPhotosKillSwitchOn()) {
		return c.json({ error: 'guest_photos_unavailable' }, 503, NO_STORE)
	}
	const verified = await verifyGuestPhotoOperatorToken(
		c.req.header('Authorization'),
	)
	if (!verified.ok) {
		return c.json({ error: verified.error }, verified.status, NO_STORE)
	}
	const access = checkGuestPhotoOperatorAccess(verified.context, requireWrite)
	if (!access.ok) {
		return c.json({ error: access.error }, access.status, NO_STORE)
	}

	const db = await getTenantDb(verified.context.orgId)
	return { ctx: verified.context, db }
}

function handleError(c: Context, error: unknown): Response {
	if (error instanceof HttpError) return error.toResponse()
	throw error
}

export function createOperatorGuestPhotoRoutes(
	deps: OperatorGuestPhotoRoutesDeps = {},
) {
	const routes = new Hono()

	routes.get('/', async (c) => {
		const auth = await requireOperatorPhotoAccess(c, false)
		if (auth instanceof Response) return auth

		const parsed = guestPhotoListQuerySchema.safeParse(c.req.query())
		if (!parsed.success) {
			return c.json({ error: 'validation_error' }, 400, NO_STORE)
		}

		try {
			const page = await listOperatorGuestPhotos(
				auth.db,
				auth.ctx.orgId,
				parsed.data,
				{ storage: deps.storage },
			)
			return c.json(page, 200, NO_STORE)
		} catch (error) {
			return handleError(c, error)
		}
	})

	routes.get('/:id', async (c) => {
		const auth = await requireOperatorPhotoAccess(c, false)
		if (auth instanceof Response) return auth

		const id = idSchema.safeParse(c.req.param('id'))
		if (!id.success) return c.json({ error: 'not_found' }, 404, NO_STORE)

		try {
			const submission = await getOperatorGuestPhoto(
				auth.db,
				auth.ctx.orgId,
				id.data,
				{ storage: deps.storage },
			)
			return c.json({ submission }, 200, NO_STORE)
		} catch (error) {
			return handleError(c, error)
		}
	})

	routes.post('/:id/decide', async (c) => {
		const auth = await requireOperatorPhotoAccess(c, true)
		if (auth instanceof Response) return auth

		const id = idSchema.safeParse(c.req.param('id'))
		if (!id.success) return c.json({ error: 'not_found' }, 404, NO_STORE)

		const body = await c.req.json().catch(() => null)
		const parsed = guestPhotoDecisionSchema.safeParse(body)
		if (!parsed.success) {
			return c.json({ error: 'validation_error' }, 400, NO_STORE)
		}

		try {
			const submission = await decideGuestPhoto(
				auth.db,
				auth.ctx.orgId,
				auth.ctx.userId,
				id.data,
				parsed.data.decision,
			)
			return c.json({ submission }, 200, NO_STORE)
		} catch (error) {
			return handleError(c, error)
		}
	})

	routes.get('/:id/signed-url', async (c) => {
		const auth = await requireOperatorPhotoAccess(c, false)
		if (auth instanceof Response) return auth

		const id = idSchema.safeParse(c.req.param('id'))
		if (!id.success) return c.json({ error: 'not_found' }, 404, NO_STORE)

		try {
			const signed = await getApprovedGuestPhotoSignedUrl(
				auth.db,
				auth.ctx.orgId,
				id.data,
				{ storage: deps.storage },
			)
			return c.json(signed, 200, NO_STORE)
		} catch (error) {
			return handleError(c, error)
		}
	})

	routes.post('/:id/added', async (c) => {
		const auth = await requireOperatorPhotoAccess(c, true)
		if (auth instanceof Response) return auth

		const id = idSchema.safeParse(c.req.param('id'))
		if (!id.success) return c.json({ error: 'not_found' }, 404, NO_STORE)

		const body = await c.req.json().catch(() => ({}))
		const parsed = guestPhotoMarkAddedSchema.safeParse(body ?? {})
		if (!parsed.success) {
			return c.json({ error: 'validation_error' }, 400, NO_STORE)
		}

		try {
			const submission = await markGuestPhotoAdded(
				auth.db,
				auth.ctx.orgId,
				id.data,
			)
			return c.json({ submission }, 200, NO_STORE)
		} catch (error) {
			return handleError(c, error)
		}
	})

	routes.post('/:id/remove', async (c) => {
		const auth = await requireOperatorPhotoAccess(c, true)
		if (auth instanceof Response) return auth

		const id = idSchema.safeParse(c.req.param('id'))
		if (!id.success) return c.json({ error: 'not_found' }, 404, NO_STORE)

		try {
			const submission = await removeGuestPhotoAdded(
				auth.db,
				auth.ctx.orgId,
				id.data,
			)
			return c.json({ submission }, 200, NO_STORE)
		} catch (error) {
			return handleError(c, error)
		}
	})

	return routes
}

export const operatorGuestPhotoRoutes = createOperatorGuestPhotoRoutes()
