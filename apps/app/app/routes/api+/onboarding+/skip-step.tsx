/**
 * `POST /api/onboarding/skip-step` `{ organizationId, stepKey, locationId,
 * reason? }`: skips an optional launch checklist step at one location.
 * Required steps are refused with `step_not_skippable`. Needs membership and
 * `update:settings:any`.
 */
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	isLaunchChecklistOn,
	skipLaunchStep,
} from '#app/utils/launch/launch.server.ts'
import { SKIP_REASON_MAX } from '#app/utils/launch/launch.ts'
import { checkUserOrganizationAccess } from '#app/utils/organization/organizations.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

const skipSchema = z.object({
	organizationId: z.string().min(1).max(64),
	stepKey: z.string().min(1).max(64),
	locationId: z.string().min(1).max(64),
	reason: z
		.string()
		.max(SKIP_REASON_MAX * 2)
		.optional(),
})

async function readBody(request: Request): Promise<unknown> {
	const type = request.headers.get('Content-Type') ?? ''
	if (type.includes('application/json')) {
		return request.json().catch(() => null)
	}
	try {
		return Object.fromEntries(await request.formData())
	} catch {
		return null
	}
}

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const parsed = skipSchema.safeParse(await readBody(request))
	if (!parsed.success) {
		return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	}
	const { organizationId, stepKey, locationId, reason } = parsed.data
	const membership = await checkUserOrganizationAccess(userId, organizationId)
	if (!membership) {
		return data({ ok: false, error: 'forbidden' }, { status: 403 })
	}
	if (
		!(await userHasOrganizationPermission(
			userId,
			organizationId,
			ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		))
	) {
		return data({ ok: false, error: 'forbidden' }, { status: 403 })
	}
	if (!(await isLaunchChecklistOn(organizationId))) {
		return data({ ok: false, error: 'not_found' }, { status: 404 })
	}
	const result = await skipLaunchStep({
		organizationId,
		userId,
		locationId,
		stepKey,
		reason,
	})
	if (!result.ok) {
		return data(result, {
			status: result.error === 'step_not_skippable' ? 400 : 404,
		})
	}
	return data(result)
}
