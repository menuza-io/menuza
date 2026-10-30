import { parseWithZod } from '@conform-to/zod/v4'
import { invalidateUserCache } from '@repo/cache'
import { db, eq, User } from '@repo/database'
import { NameSchema, UsernameSchema } from '@repo/validation'
import { z } from 'zod'

export const ProfileFormSchema = z.object({
	name: NameSchema.nullable().default(null),
	username: UsernameSchema,
})

type ProfileActionArgs = {
	userId: string
	formData: FormData
}

export async function profileUpdateAction({
	userId,
	formData,
}: ProfileActionArgs) {
	const submission = await parseWithZod(formData, {
		async: true,
		schema: ProfileFormSchema.superRefine(async ({ username }, ctx) => {
			const [existingUsername] = await db
				.select({ id: User.id })
				.from(User)
				.where(eq(User.username, username))
				.limit(1)
			if (existingUsername && existingUsername.id !== userId) {
				ctx.addIssue({
					path: ['username'],
					code: z.ZodIssueCode.custom,
					message: 'A user already exists with this username',
				})
			}
		}),
	})
	if (submission.status !== 'success') {
		return Response.json(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { username, name } = submission.value

	await db
		.update(User)
		.set({
			name: name,
			username: username,
		})
		.where(eq(User.id, userId))
	// The root loader caches name and username for the sidebar user card.
	await invalidateUserCache(userId)

	return Response.json({
		result: submission.reply(),
	})
}
