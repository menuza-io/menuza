import {
	and,
	db,
	desc,
	eq,
	Organization,
	OrganizationNoteStatus,
} from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { NOTE_STATUS_NAME_MAX_LENGTH } from '#app/utils/note-status.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

export const action = async ({ request, params }: ActionFunctionArgs) => {
	const orgSlug = params.orgSlug
	if (!orgSlug) return new Response('Missing orgSlug', { status: 400 })

	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(eq(Organization.slug, orgSlug))
		.limit(1)
	if (!organization)
		return new Response('Organization not found', { status: 404 })

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const formData = await request.formData()
	const name = formData.get('name')?.toString().trim()
	const color = formData.get('color')?.toString().trim() || '#6b7280'
	if (!name) return new Response('Missing name', { status: 400 })
	if (name.length > NOTE_STATUS_NAME_MAX_LENGTH)
		return new Response('Name too long', { status: 400 })

	// Prevent duplicate status names in org
	const [existing] = await db
		.select({ id: OrganizationNoteStatus.id })
		.from(OrganizationNoteStatus)
		.where(
			and(
				eq(OrganizationNoteStatus.organizationId, organization.id),
				eq(OrganizationNoteStatus.name, name),
			),
		)
		.limit(1)
	if (existing) return new Response('Already exists', { status: 409 })

	// Determine next position (always append at end)
	const [maxPos] = await db
		.select({ position: OrganizationNoteStatus.position })
		.from(OrganizationNoteStatus)
		.where(eq(OrganizationNoteStatus.organizationId, organization.id))
		.orderBy(desc(OrganizationNoteStatus.position))
		.limit(1)
	const nextPosition = (maxPos?.position ?? 0) + 1.0

	const [created] = await db
		.insert(OrganizationNoteStatus)
		.values({
			organizationId: organization.id,
			name,
			color,
			position: nextPosition,
		})
		.returning({
			id: OrganizationNoteStatus.id,
			name: OrganizationNoteStatus.name,
			color: OrganizationNoteStatus.color,
			position: OrganizationNoteStatus.position,
		})

	return Response.json(created)
}
