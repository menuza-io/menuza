import { requireUserId } from '@repo/auth'
import { redirect, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	getUserOrganizations,
	setUserDefaultOrganization,
} from '#app/utils/organization/organizations.server.ts'

const SetDefaultOrganizationSchema = z.object({
	organizationId: z.string().min(1, 'Organization ID is required'),
})

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)

	const formData = await request.formData()
	const result = SetDefaultOrganizationSchema.safeParse(
		Object.fromEntries(formData),
	)

	if (!result.success) {
		return Response.json(
			{ errors: z.flattenError(result.error) },
			{ status: 400 },
		)
	}

	const { organizationId } = result.data

	// Check if the user has access to the organization
	const userOrganizations = await getUserOrganizations(userId)
	const hasAccess = userOrganizations.find(
		(userOrg) => userOrg.organization.id === organizationId,
	)

	if (!hasAccess) {
		return Response.json(
			{
				errors: { formErrors: ['You do not have access to this organization'] },
			},
			{ status: 403 },
		)
	}

	// Set the organization as the default
	await setUserDefaultOrganization(userId, organizationId)

	// Redirect back to the previous page or a default location
	return redirect(`/${hasAccess.organization.slug}`)
}
