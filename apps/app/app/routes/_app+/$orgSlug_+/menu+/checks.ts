import { requireUserId } from '@repo/auth'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import {
	dismissMenuCheck,
	MENU_CHECK_DISMISS_REASONS,
	MenuCheckDismissalError,
	restoreMenuCheck,
} from '#app/utils/menu/menu-check-dismissals.server.ts'
import { MENU_HEALTH_CHECK_KEYS } from '#app/utils/menu/menu-health.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

/**
 * `POST /:orgSlug/menu/checks`: dismiss one Menu health check for one record
 * ("No photo on purpose"), or restore it. JSON body with `intent`. Needs
 * `update:menu:any` (menu write rate limit included); seeing health needs
 * only `read:menu:any`, on the Menu overview.
 */

const BodySchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('dismiss'),
		checkKey: z.enum(MENU_HEALTH_CHECK_KEYS),
		entityId: z.string().min(1).max(64),
		reason: z.enum(MENU_CHECK_DISMISS_REASONS).default('on_purpose'),
	}),
	z.object({
		intent: z.literal('restore'),
		checkKey: z.enum(MENU_HEALTH_CHECK_KEYS),
		entityId: z.string().min(1).max(64),
	}),
])

export type MenuChecksBody = z.input<typeof BodySchema>

function fail(error: string, status: number) {
	return Response.json({ ok: false as const, error }, { status })
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	const userId = await requireMenuWrite(request, organization.id)

	let raw: unknown
	try {
		raw = await request.json()
	} catch {
		return fail('invalid_input', 400)
	}
	const parsed = BodySchema.safeParse(raw)
	if (!parsed.success) return fail('invalid_input', 400)
	const body = parsed.data

	try {
		if (body.intent === 'dismiss') {
			await dismissMenuCheck({
				organization,
				userId,
				request,
				checkKey: body.checkKey,
				entityId: body.entityId,
				reason: body.reason,
			})
		} else {
			await restoreMenuCheck({
				organization,
				userId,
				request,
				checkKey: body.checkKey,
				entityId: body.entityId,
			})
		}
		return Response.json({ ok: true as const })
	} catch (error) {
		if (error instanceof MenuCheckDismissalError) {
			return fail(error.code, error.code === 'not_found' ? 404 : 400)
		}
		throw error
	}
}
