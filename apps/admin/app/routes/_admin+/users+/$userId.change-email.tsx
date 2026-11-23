import { AuditAction } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { User, and, db, eq, ne } from '@repo/database'
import { EmailChangeNoticeEmail, sendEmail } from '@repo/email'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	auditSupportAction,
	requireSensitiveSupportAction,
} from '#app/utils/support.server.ts'

const EmailSchema = z.object({ email: z.email().max(254) })

/** `j***@example.com`: audit rows never hold a full address. */
function mask(email: string) {
	const [local = '', domain = ''] = email.split('@')
	return `${local.slice(0, 1)}***@${domain}`
}

/**
 * Change a user's email. The gate is the first thing that runs: without a
 * verification of this user by this agent from the last 15 minutes the action
 * is refused with a 403 before the form is read (#291).
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const userId = params.userId
	if (!userId) throw data({ error: 'not_found' }, { status: 404 })
	await requireSensitiveSupportAction({
		request,
		agentId,
		userId,
		action: 'change_email',
	})

	const parsed = EmailSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return data({ error: 'invalid_email' as const }, { status: 400 })
	}
	const email = parsed.data.email.trim().toLowerCase()

	const [before] = await db
		.select({
			id: User.id,
			email: User.email,
			name: User.name,
			username: User.username,
		})
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	if (!before) throw data({ error: 'not_found' }, { status: 404 })
	if (before.email.toLowerCase() === email) {
		return data({ error: 'unchanged' as const }, { status: 400 })
	}
	const [taken] = await db
		.select({ id: User.id })
		.from(User)
		.where(and(eq(User.email, email), ne(User.id, userId)))
		.limit(1)
	if (taken) return data({ error: 'email_in_use' as const }, { status: 409 })

	await db.update(User).set({ email }).where(eq(User.id, userId))

	await auditSupportAction({
		action: AuditAction.ADMIN_USER_EMAIL_CHANGED,
		agentId,
		targetUserId: userId,
		resourceType: 'User',
		resourceId: userId,
		details: `Changed the email of a user (${mask(before.email)} to ${mask(email)})`,
		metadata: { from: mask(before.email), to: mask(email) },
		request,
	})

	// The old address is told, as in the member's own change: a takeover cannot be silent.
	void sendEmail({
		to: before.email,
		subject: 'Your email address was changed',
		react: EmailChangeNoticeEmail({
			userId,
			firstName: before.name?.trim().split(/\s+/)[0] || before.username,
		}),
	}).catch(() => undefined)

	return redirectWithToast(`/users/${userId}`, {
		type: 'success',
		title: 'Email changed',
		description: 'The previous address was told.',
	})
}
