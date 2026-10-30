import { requireUserId } from '@repo/auth'
import { and, db, eq, Feedback, UserOrganization } from '@repo/database'
import { z } from 'zod'

const FeedbackSchema = z.object({
	message: z.string().min(1).max(5000, 'Feedback message is too long'),
	type: z.enum(['positive', 'neutral', 'negative']),
})

export async function action({ request }: { request: Request }) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	const result = FeedbackSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json(
			{ status: 'error', errors: z.flattenError(result.error) },
			{ status: 400 },
		)
	}

	const { message, type } = result.data

	const [userOrganization] = await db
		.select({ organizationId: UserOrganization.organizationId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.isDefault, true),
			),
		)
		.limit(1)

	if (!userOrganization) {
		return Response.json(
			{ status: 'error', message: 'Default organization not found' },
			{ status: 400 },
		)
	}

	await db.insert(Feedback).values({
		message,
		type: type.toUpperCase(),
		userId,
		organizationId: userOrganization.organizationId,
	})

	return Response.json({ status: 'success' })
}
