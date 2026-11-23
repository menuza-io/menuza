import { parseFormData } from '@mjackson/form-data-parser'
import { requireUserId } from '@repo/auth'
import {
	SUPPORT_SCREENSHOT_MAX_BYTES,
	createSupportRequestSchema,
} from '@repo/common/support-requests'
import { OrganizationLocation, and, db, eq } from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { refuseWhileImpersonating } from '#app/utils/impersonation-guard.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	SUPPORT_REQUEST_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { uploadSupportScreenshot } from '#app/utils/storage.server.ts'
import {
	createSupportRequest,
	resolveSupportOrganization,
} from '#app/utils/support.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** The build the page came from: the commit, short. Decided here, not by the browser. */
export function currentAppVersion(): string {
	return String(ENV.COMMIT_SHA ?? '').slice(0, 12) || 'dev'
}

/**
 * `POST /resources/support`: Contact support and Report a problem (#233). The
 * request is a `Feedback` record with a kind, and the context is an allowlist:
 * the restaurant, the location, the page path (no query string), the app version
 * and the error reference. Nothing about a guest is attached: the browser sends
 * a path and an error id, the rest is looked up here from ids. Control plane
 * only, so it works while a regional node is down.
 *
 * One optional screenshot (PNG, JPEG or WebP, 4 MB). Rate limited per member.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const userId = await requireUserId(request)
	// An admin impersonating a member must not write to support as them.
	await refuseWhileImpersonating(
		request,
		'Stop impersonating before contacting support',
	)

	let form: FormData
	try {
		form = await parseFormData(request, {
			maxFileSize: SUPPORT_SCREENSHOT_MAX_BYTES,
		})
	} catch {
		return Response.json(
			{ status: 'error', error: 'screenshot_too_large' },
			{ status: 413, headers: NO_STORE },
		)
	}

	const { screenshot, locationId, ...fields } = Object.fromEntries(form)
	const parsed = createSupportRequestSchema.safeParse(fields)
	if (!parsed.success) {
		// Field names only: a rejected value is never echoed back.
		return Response.json(
			{
				status: 'error',
				error: 'invalid_request',
				fields: parsed.error.issues.map((issue) => issue.path.join('.')),
			},
			{ status: 400, headers: NO_STORE },
		)
	}

	const organization = await resolveSupportOrganization(
		userId,
		parsed.data.organizationSlug,
	)
	if (!organization) {
		return Response.json(
			{ status: 'error', error: 'not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}

	const limit = await checkRateLimit(
		{ type: 'user', value: userId },
		SUPPORT_REQUEST_RATE_LIMIT,
	)
	if (!limit.allowed) return createRateLimitResponse(limit.resetAt)

	// A location counts only if it belongs to this restaurant.
	let validLocationId: string | null = null
	if (typeof locationId === 'string' && locationId && locationId.length <= 64) {
		const [location] = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)
			.limit(1)
		validLocationId = location?.id ?? null
	}

	let screenshotKey: string | null = null
	if (screenshot instanceof File && screenshot.size > 0) {
		try {
			screenshotKey = await uploadSupportScreenshot(userId, screenshot)
		} catch {
			return Response.json(
				{ status: 'error', error: 'invalid_screenshot' },
				{ status: 400, headers: NO_STORE },
			)
		}
	}

	const created = await createSupportRequest({
		userId,
		organization,
		kind: parsed.data.kind,
		subject: parsed.data.subject,
		message: parsed.data.message,
		path: parsed.data.path,
		errorId: parsed.data.errorId,
		appVersion: currentAppVersion(),
		locationId: validLocationId,
		screenshotKey,
		request,
	})
	return Response.json({ status: 'ok', id: created.id }, { headers: NO_STORE })
}
