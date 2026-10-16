import { parseWithZod } from '@conform-to/zod'
import { invalidateUserCache } from '@repo/cache'
import { db, eq, User, UserImage } from '@repo/database'
import { NameSchema, UsernameSchema } from '@repo/validation'
import { data } from 'react-router'
import { z } from 'zod'
import { requireAuth } from '#app/utils/jwt.server.ts'
import { type Route } from './+types/profile.ts'

const ProfileFormSchema = z.object({
	name: NameSchema.nullable().default(null),
	username: UsernameSchema,
})

export async function action({ request }: Route.ActionArgs) {
	try {
		const payload = await requireAuth(request)
		const userId = payload.sub

		const [user] = await db
			.select({ id: User.id })
			.from(User)
			.where(eq(User.id, userId))
			.limit(1)

		if (!user) {
			return data(
				{
					success: false,
					error: 'user_not_found',
					message: 'User not found',
				},
				{ status: 404 },
			)
		}

		const formData = await request.formData()
		const intent = formData.get('intent')

		if (intent !== 'update-profile') {
			return data(
				{
					success: false,
					error: 'invalid_intent',
					message: 'Invalid intent',
				},
				{ status: 400 },
			)
		}

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
			return data(
				{
					success: false,
					error: 'validation_error',
					message: 'Validation failed',
					errors: submission.reply(),
				},
				{ status: 400 },
			)
		}

		const { username, name } = submission.value

		const [updatedUser] = await db
			.update(User)
			.set({ name, username })
			.where(eq(User.id, userId))
			.returning({
				id: User.id,
				email: User.email,
				username: User.username,
				name: User.name,
				createdAt: User.createdAt,
				updatedAt: User.updatedAt,
			})
		if (!updatedUser) throw new Error('User not found')
		// The web root loader caches name and username for the sidebar user card.
		await invalidateUserCache(userId)
		const [image] = await db
			.select({ objectKey: UserImage.objectKey })
			.from(UserImage)
			.where(eq(UserImage.userId, userId))
			.limit(1)

		return data({
			success: true,
			data: {
				user: {
					id: updatedUser.id,
					email: updatedUser.email,
					username: updatedUser.username,
					name: updatedUser.name,
					image: image?.objectKey,
					createdAt: updatedUser.createdAt.toISOString(),
					updatedAt: updatedUser.updatedAt.toISOString(),
				},
			},
		})
	} catch (error) {
		if (error instanceof Error && error.message.includes('authorization')) {
			return data(
				{
					success: false,
					error: 'unauthorized',
					message: 'Authentication required',
				},
				{ status: 401 },
			)
		}

		console.error('Profile API error:', error)
		return data(
			{
				success: false,
				error: 'internal_error',
				message: 'Failed to update profile',
			},
			{ status: 500 },
		)
	}
}

export async function loader() {
	return data(
		{
			success: false,
			error: 'method_not_allowed',
			message: 'Use POST method to update profile',
		},
		{ status: 405 },
	)
}
