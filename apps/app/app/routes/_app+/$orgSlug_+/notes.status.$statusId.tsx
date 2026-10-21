import {
	and,
	db,
	eq,
	ne,
	Organization,
	OrganizationNote,
	OrganizationNoteStatus,
} from '@repo/database'
import { type ActionFunction } from 'react-router'
import { NOTE_STATUS_NAME_MAX_LENGTH } from '#app/utils/note-status.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

export const action: ActionFunction = async ({ request, params }) => {
	const orgSlug = params.orgSlug
	const statusId = params.statusId
	if (!orgSlug || !statusId)
		return new Response('Missing params', { status: 400 })
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

	if (request.method === 'PATCH') {
		const formData = await request.formData()
		const name = formData.get('name')?.toString().trim()
		const color = formData.get('color')?.toString().trim()
		if (!name) return new Response('Missing name', { status: 400 })
		if (name.length > NOTE_STATUS_NAME_MAX_LENGTH)
			return new Response('Name too long', { status: 400 })

		// Check for duplicate name
		const [existing] = await db
			.select({ id: OrganizationNoteStatus.id })
			.from(OrganizationNoteStatus)
			.where(
				and(
					eq(OrganizationNoteStatus.organizationId, organization.id),
					eq(OrganizationNoteStatus.name, name),
					ne(OrganizationNoteStatus.id, statusId),
				),
			)
			.limit(1)
		if (existing) return new Response('Name already exists', { status: 409 })

		const updateData: { name: string; color?: string } = { name }
		if (color) updateData.color = color

		const [updated] = await db
			.update(OrganizationNoteStatus)
			.set(updateData)
			.where(
				and(
					eq(OrganizationNoteStatus.id, statusId),
					eq(OrganizationNoteStatus.organizationId, organization.id),
				),
			)
			.returning({
				id: OrganizationNoteStatus.id,
				name: OrganizationNoteStatus.name,
				color: OrganizationNoteStatus.color,
				position: OrganizationNoteStatus.position,
			})

		return Response.json(updated)
	} else if (request.method === 'DELETE') {
		await db.transaction(async (tx) => {
			await tx
				.update(OrganizationNote)
				.set({ statusId: null })
				.where(
					and(
						eq(OrganizationNote.statusId, statusId),
						eq(OrganizationNote.organizationId, organization.id),
					),
				)
			await tx
				.delete(OrganizationNoteStatus)
				.where(
					and(
						eq(OrganizationNoteStatus.id, statusId),
						eq(OrganizationNoteStatus.organizationId, organization.id),
					),
				)
		})
		return new Response('OK', { status: 200 })
	}

	return new Response('Method Not Allowed', { status: 405 })
}
