import { data } from 'react-router'
import { z } from 'zod'
import { isAuthenticationError, requireAuth } from '#app/utils/jwt.server.ts'
import {
	getUserOrganizations,
	setUserDefaultOrganization,
} from '#app/utils/organization/organizations.server.ts'
import { type Route } from './+types/organizations.set-default.ts'

const SetDefaultSchema = z.object({
	organizationId: z.string().min(1, 'Organization ID is required'),
})

export async function action({ request }: Route.ActionArgs) {
	try {
		const payload = await requireAuth(request)
		const userId = payload.sub

		const formData = await request.formData()
		const result = SetDefaultSchema.safeParse(Object.fromEntries(formData))

		if (!result.success) {
			return data(
				{
					success: false,
					error: 'validation_error',
					message: 'Invalid organization ID',
					errors: result.error.flatten(),
				},
				{ status: 400 },
			)
		}

		const { organizationId } = result.data

		const userOrganizations = await getUserOrganizations(userId)
		const hasAccess = userOrganizations.find(
			(userOrg) => userOrg.organization.id === organizationId,
		)

		if (!hasAccess) {
			return data(
				{
					success: false,
					error: 'forbidden',
					message: 'You do not have access to this organization',
				},
				{ status: 403 },
			)
		}

		await setUserDefaultOrganization(userId, organizationId)

		return data({
			success: true,
			data: { organizationSlug: hasAccess.organization.slug },
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

		console.error('Set default organization API error:', error)
		return data(
			{
				success: false,
				error: 'internal_error',
				message: 'Failed to set default organization',
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
			message: 'Use POST method',
		},
		{ status: 405 },
	)
}
