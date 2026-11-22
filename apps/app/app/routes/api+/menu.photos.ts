import { getDomainUrl } from '@repo/common'
import { db, eq, Organization } from '@repo/database'
import { data } from 'react-router'
import { z } from 'zod'
import { isAuthenticationError, requireAuth } from '#app/utils/jwt.server.ts'
import {
	attachPhonePhoto,
	listPhoneDishes,
	memberMayEditMenu,
	PHONE_PHOTO_LIST_MAX,
	PHONE_PHOTO_MAX_BYTES,
} from '#app/utils/menu/phone-photos.server.ts'
import {
	checkRateLimit,
	MENU_MUTATION_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { type Route } from './+types/menu.photos.ts'

/**
 * Menu photos for the operator phone app (#222). Bearer token (the mobile
 * operator token), not a cookie. Everything is checked per request: the member
 * must be in the organization and hold `update:menu:any`, the same permission
 * as the web dish form (location scope does not apply to menu edits there).
 *
 * GET  `?organizationId=&query=&limit=`: the dishes with no photo, best sellers
 *      first; with `query`, any dish by name (to replace its photo).
 * POST multipart `organizationId`, `itemId`, `clientId`, `photo`: attaches the
 *      photo (idempotent per `clientId`), metadata stripped, the old photo kept
 *      in the library as a version.
 */

const ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const ListQuery = z.object({
	organizationId: ID,
	query: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(PHONE_PHOTO_LIST_MAX).optional(),
})
const UploadFields = z.object({
	organizationId: ID,
	itemId: z.string().min(1).max(100),
	clientId: ID,
})

function failure(
	status: number,
	error: string,
	message: string,
	extra: Record<string, unknown> = {},
) {
	return data({ success: false, error, message, ...extra }, { status })
}

function unauthorized() {
	return failure(401, 'unauthorized', 'Authentication required')
}

/** Not a member and no permission look the same: nothing leaks about others. */
async function mayEdit(userId: string, organizationId: string) {
	return memberMayEditMenu(userId, organizationId)
}

/** 429 in the API's own shape (the phone app reads `rate_limited`). */
async function limited(userId: string, scope: string, maxRequests: number) {
	const limit = await checkRateLimit(
		{ type: 'user', value: userId },
		{ ...MENU_MUTATION_RATE_LIMIT, scope, maxRequests },
	)
	if (limit.allowed) return null
	const retryAfter = Math.max(
		1,
		Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000),
	)
	return data(
		{
			success: false,
			error: 'rate_limited',
			message: 'Too many requests. Try again shortly.',
		},
		{ status: 429, headers: { 'Retry-After': String(retryAfter) } },
	)
}

/**
 * Reads the request body without ever holding more than `maxBytes` of it: a
 * chunked request has no Content-Length to trust, and `request.formData()`
 * would buffer all of it. `null` means it was too large.
 */
async function readBodyCapped(request: Request, maxBytes: number) {
	if (!request.body) return new Uint8Array()
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined)
			return null
		}
		chunks.push(value)
	}
	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return body
}

export async function loader({ request }: Route.LoaderArgs) {
	let userId: string
	try {
		userId = (await requireAuth(request)).sub
	} catch (error) {
		if (isAuthenticationError(error)) return unauthorized()
		throw error
	}
	const tooMany = await limited(userId, 'mobile-menu-photos-list', 120)
	if (tooMany) return tooMany
	const url = new URL(request.url)
	const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams))
	if (!parsed.success) {
		return failure(400, 'validation_error', 'Invalid request', {
			errors: z.flattenError(parsed.error),
		})
	}
	if (!(await mayEdit(userId, parsed.data.organizationId))) {
		return failure(403, 'forbidden', 'You need permission to edit the menu')
	}
	const result = await listPhoneDishes({
		organizationId: parsed.data.organizationId,
		query: parsed.data.query,
		limit: parsed.data.limit,
		origin: getDomainUrl(request),
	})
	return data({
		success: true,
		data: { organizationId: parsed.data.organizationId, ...result },
	})
}

export async function action({ request }: Route.ActionArgs) {
	let userId: string
	try {
		userId = (await requireAuth(request)).sub
	} catch (error) {
		if (isAuthenticationError(error)) return unauthorized()
		throw error
	}
	if (request.method !== 'POST') {
		return failure(405, 'method_not_allowed', 'Method not allowed')
	}
	// The rate limit comes before anything is read, so a flood of large bodies
	// is stopped at the door.
	const tooMany = await limited(userId, 'mobile-menu-photos', 300)
	if (tooMany) return tooMany
	// Refuse an oversized body before reading it, and never buffer more than the
	// cap whatever Content-Length says (or does not say).
	const maxBody = PHONE_PHOTO_MAX_BYTES + 64 * 1024
	const declared = Number(request.headers.get('content-length') ?? 0)
	if (declared > maxBody) {
		return failure(413, 'payload_too_large', 'The photo is too large')
	}
	const body = await readBodyCapped(request, maxBody)
	if (!body) return failure(413, 'payload_too_large', 'The photo is too large')
	let form: FormData
	try {
		form = await new Response(body as BodyInit, {
			headers: { 'content-type': request.headers.get('content-type') ?? '' },
		}).formData()
	} catch {
		return failure(400, 'validation_error', 'Invalid request')
	}
	const fields = UploadFields.safeParse({
		organizationId: form.get('organizationId'),
		itemId: form.get('itemId'),
		clientId: form.get('clientId'),
	})
	if (!fields.success) {
		return failure(400, 'validation_error', 'Invalid request', {
			errors: z.flattenError(fields.error),
		})
	}
	if (!(await mayEdit(userId, fields.data.organizationId))) {
		return failure(403, 'forbidden', 'You need permission to edit the menu')
	}

	const photo = form.get('photo')
	if (!(photo instanceof File) || photo.size === 0) {
		return failure(
			400,
			'validation_error',
			'Send the photo in the "photo" field',
		)
	}
	if (photo.size > PHONE_PHOTO_MAX_BYTES) {
		return failure(413, 'payload_too_large', 'The photo is too large')
	}

	const [organization] = await db
		.select({ id: Organization.id, slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, fields.data.organizationId))
		.limit(1)
	if (!organization) return failure(404, 'not_found', 'Not found')

	const result = await attachPhonePhoto({
		organization,
		userId,
		request,
		itemId: fields.data.itemId,
		clientId: fields.data.clientId,
		bytes: new Uint8Array(await photo.arrayBuffer()),
		declaredType: photo.type,
	})
	if (result.ok) {
		return data({
			success: true,
			data: {
				itemId: result.itemId,
				assetId: result.assetId,
				imageUrl: new URL(result.imageUrl, getDomainUrl(request)).href,
			},
		})
	}
	switch (result.error) {
		case 'not_found':
			return failure(404, 'not_found', 'Dish not found')
		case 'forbidden_pos':
			return failure(
				403,
				'forbidden',
				'This dish photo comes from your point of sale',
			)
		case 'unsupported_media_type':
			return failure(
				415,
				'unsupported_media_type',
				'Use a JPEG, PNG or WebP photo',
			)
		case 'payload_too_large':
			return failure(413, 'payload_too_large', 'The photo is too large')
		default:
			return failure(500, 'internal_error', 'The photo could not be saved')
	}
}
