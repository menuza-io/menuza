import { requireUserId } from '@repo/auth'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { assertItemInOrganization } from '#app/utils/menu/ownership.server.ts'
import {
	endPhotoTest,
	startPhotoTest,
	type PhotoTestError,
} from '#app/utils/menu/photo-tests.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/items_.$itemId.photo-test.ts'

/**
 * Start or end a dish photo test (#192): "Try another photo" starts one with a
 * library photo as photo B; ending keeps photo A, keeps photo B (the dish's main
 * photo changes everywhere) or just stops. Permission is the dish form's
 * (`update:menu:any`). The losing photo is never deleted from the library.
 */
const StartSchema = z.object({
	intent: z.literal('start'),
	assetId: z.string().min(1).max(100),
})
const EndSchema = z.object({
	intent: z.literal('end'),
	testId: z.string().min(8).max(64),
	choice: z.enum(['A', 'B', 'stop']),
})

const STATUS: Record<PhotoTestError, number> = {
	flag_off: 404,
	not_found: 404,
	asset_not_found: 404,
	no_photo: 409,
	asset_not_ready: 409,
	same_photo: 409,
	test_running: 409,
	too_many_tests: 409,
	photo_changed: 409,
	already_ended: 409,
}

export async function action({ request, params }: Route.ActionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const userId = await requireMenuWrite(request, organization.id)
	const itemId = params.itemId
	await assertItemInOrganization(organization.id, itemId)

	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent === 'start') {
		const parsed = StartSchema.safeParse(Object.fromEntries(formData))
		if (!parsed.success)
			return Response.json({ ok: false, error: 'invalid' }, { status: 400 })
		const result = await startPhotoTest({
			organization,
			userId,
			request,
			itemId,
			assetId: parsed.data.assetId,
		})
		return result.ok
			? Response.json({ ok: true, testId: result.testId })
			: Response.json(result, { status: STATUS[result.error] })
	}
	if (intent === 'end') {
		const parsed = EndSchema.safeParse(Object.fromEntries(formData))
		if (!parsed.success)
			return Response.json({ ok: false, error: 'invalid' }, { status: 400 })
		const result = await endPhotoTest({
			organization,
			userId,
			request,
			testId: parsed.data.testId,
			choice: parsed.data.choice,
		})
		return result.ok
			? Response.json({ ok: true })
			: Response.json(result, { status: STATUS[result.error] })
	}
	return Response.json({ ok: false, error: 'invalid' }, { status: 400 })
}
