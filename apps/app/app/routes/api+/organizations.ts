import { db, eq, User } from '@repo/database'
import { data } from 'react-router'
import { isAuthenticationError, requireAuth } from '#app/utils/jwt.server.ts'
import { type Route } from './+types/organizations.ts'

export async function loader({ request }: Route.LoaderArgs) {
	try {
		// Verify JWT token and get user info
		const payload = await requireAuth(request)

		// Check if user exists
		const [user] = await db
			.select({ id: User.id, email: User.email, username: User.username })
			.from(User)
			.where(eq(User.id, payload.sub))
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

		const userOrganizations = await db.query.UserOrganization.findMany({
			columns: { isDefault: true },
			with: {
				organization: {
					columns: {
						id: true,
						name: true,
						slug: true,
						description: true,
						active: true,
						createdAt: true,
						updatedAt: true,
					},
					with: { images: { columns: { id: true, objectKey: true } } },
				},
				organizationRole: {
					columns: { id: true, name: true, level: true },
				},
			},
			where: (membership, { and, eq }) =>
				and(eq(membership.userId, payload.sub), eq(membership.active, true)),
		})
		userOrganizations.sort(
			(a, b) =>
				Number(b.isDefault) - Number(a.isDefault) ||
				a.organization.name.localeCompare(b.organization.name),
		)

		const organizations = userOrganizations.map((userOrg) => ({
			id: userOrg.organization.id,
			name: userOrg.organization.name,
			slug: userOrg.organization.slug,
			description: userOrg.organization.description,
			active: userOrg.organization.active,
			isDefault: userOrg.isDefault,
			role: {
				id: userOrg.organizationRole.id,
				name: userOrg.organizationRole.name,
				level: userOrg.organizationRole.level,
			},
			image: userOrg.organization.images[0]?.objectKey,
			createdAt: userOrg.organization.createdAt.toISOString(),
			updatedAt: userOrg.organization.updatedAt.toISOString(),
		}))

		return data({
			success: true,
			data: { organizations },
		})
	} catch (error) {
		if (isAuthenticationError(error)) {
			return data(
				{
					success: false,
					error: 'unauthorized',
					message: 'Authentication required',
				},
				{ status: 401 },
			)
		}

		console.error('Organizations API error:', error)
		return data(
			{
				success: false,
				error: 'internal_error',
				message: 'Failed to fetch organizations',
			},
			{ status: 500 },
		)
	}
}

export async function action() {
	return data(
		{
			success: false,
			error: 'method_not_allowed',
			message: 'Use GET method to fetch organizations',
		},
		{ status: 405 },
	)
}
