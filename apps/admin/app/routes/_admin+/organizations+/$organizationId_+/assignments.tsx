import { requireUserWithRole } from '@repo/auth'
import { assignSchema } from '@repo/common/support-assignments'
import { redirectWithToast } from '@repo/common/toast'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	assignContact,
	unassignContact,
} from '#app/utils/assignments.server.ts'

const UnassignSchema = z.object({
	assignmentId: z.string().trim().min(1).max(64),
})

/**
 * Assign, reassign or remove a Menuza contact for a restaurant (#272). Admin
 * only. It names a person and routes support requests; it gives that person no
 * access they did not already have.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const organizationId = params.organizationId
	if (!organizationId) throw data({ error: 'not_found' }, { status: 404 })
	const form = Object.fromEntries(await request.formData())
	const back = `/organizations/${organizationId}`

	if (form.intent === 'unassign') {
		const parsed = UnassignSchema.safeParse(form)
		if (!parsed.success) throw data({ error: 'invalid' }, { status: 400 })
		const result = await unassignContact({
			assignmentId: parsed.data.assignmentId,
			byAgentId: agentId,
			request,
		})
		if (result === 'not_found')
			throw data({ error: 'not_found' }, { status: 404 })
		return redirectWithToast(back, {
			type: 'success',
			title: 'Contact removed',
			description: 'The history is kept.',
		})
	}

	const parsed = assignSchema.safeParse({
		role: form.role,
		adminUserId: form.adminUserId,
		locationId: form.locationId,
	})
	if (!parsed.success) throw data({ error: 'invalid' }, { status: 400 })
	const result = await assignContact({
		organizationId,
		...parsed.data,
		byAgentId: agentId,
		request,
	})
	if (result.status === 'assigned') {
		return redirectWithToast(back, {
			type: 'success',
			title: result.replaced ? 'Contact reassigned' : 'Contact assigned',
			description: 'The history is kept.',
		})
	}
	if (result.status === 'unchanged') {
		return redirectWithToast(back, {
			type: 'message',
			title: 'No change',
			description: 'That person already holds this role.',
		})
	}
	throw data({ error: result.status }, { status: 400 })
}
