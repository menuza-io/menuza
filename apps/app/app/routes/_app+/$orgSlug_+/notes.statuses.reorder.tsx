import { calculateReorderPosition } from '@repo/common'
import { and, db, eq, ne, asc, OrganizationNoteStatus } from '@repo/database'
import { type ActionFunction } from 'react-router'
import { validateOrgAccess } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

export const action: ActionFunction = async ({ request, params }) => {
	const organization = await validateOrgAccess(request, params.orgSlug)
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const formData = await request.formData()
	const statusId = formData.get('statusId')?.toString()
	const positionStr = formData.get('position')?.toString()

	if (!statusId || !positionStr)
		return new Response('Missing fields', { status: 400 })

	const targetIndex = Number(positionStr)
	if (!Number.isInteger(targetIndex) || targetIndex < 0) {
		return new Response('Invalid position', { status: 400 })
	}

	// Validate statusId
	const [statusToMove] = await db
		.select({ id: OrganizationNoteStatus.id })
		.from(OrganizationNoteStatus)
		.where(
			and(
				eq(OrganizationNoteStatus.id, statusId),
				eq(OrganizationNoteStatus.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!statusToMove) return new Response('Status not found', { status: 404 })

	// Use a transaction to calculate and update position
	await db.transaction(async (tx) => {
		// Get all statuses in the organization (excluding the one being moved)
		const allStatuses = await tx
			.select({
				id: OrganizationNoteStatus.id,
				position: OrganizationNoteStatus.position,
			})
			.from(OrganizationNoteStatus)
			.where(
				and(
					eq(OrganizationNoteStatus.organizationId, organization.id),
					ne(OrganizationNoteStatus.id, statusId),
				),
			)
			.orderBy(asc(OrganizationNoteStatus.position))

		// Calculate the new fractional position using shared utility
		const newPosition = calculateReorderPosition(
			allStatuses.map((s) => ({ position: s.position ?? 0 })),
			targetIndex,
		)

		// Update the status with new position
		await tx
			.update(OrganizationNoteStatus)
			.set({ position: newPosition })
			.where(eq(OrganizationNoteStatus.id, statusId))
	})

	return new Response(null, { status: 204 })
}
