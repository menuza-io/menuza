import { requireUserWithRole } from '@repo/auth'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { postToApp } from '#app/utils/app-service.server.ts'
import {
	setupReminderAnswerSchema,
	type SetupReminderAnswer,
} from '#app/utils/setup-reminder.ts'

const FormSchema = z.object({ intent: z.enum(['preview', 'send']) })

/**
 * Admin's setup reminder (#271): `preview` asks the App what the reminder would
 * say and to how many owners; `send` sends one (once a day per organization,
 * audit logged by the App). The App owns the launch checklist and the sending;
 * Admin only asks, with the internal command token.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const organizationId = params.organizationId
	if (!organizationId) throw data({ error: 'not_found' }, { status: 404 })
	const parsed = FormSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) return data({ error: 'invalid_form' }, { status: 400 })

	const result = await postToApp(
		'/resources/setup-reminder',
		parsed.data.intent === 'preview'
			? { intent: 'preview', organizationId }
			: { intent: 'send', organizationId, adminUserId: agentId },
		{ timeoutMs: 15_000 },
	)
	const unavailable: SetupReminderAnswer = { status: 'unavailable' }
	if (result.status !== 'answered' || !result.response.ok) {
		return data({ answer: unavailable })
	}
	const answer = setupReminderAnswerSchema.safeParse(
		await result.response.json().catch(() => null),
	)
	return data({ answer: answer.success ? answer.data : unavailable })
}
