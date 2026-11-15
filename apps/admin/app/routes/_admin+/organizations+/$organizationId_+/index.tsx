import { invariant } from '@epic-web/invariant'
import { requireUserWithRole } from '@repo/auth'
import {
	NoteActivityLog,
	Organization,
	OrganizationInvitation,
	OrganizationNote,
	User,
	UserOrganization,
	db,
	desc,
	eq,
} from '@repo/database'
import { useLoaderData } from 'react-router'
import { AdminLaunchCard } from '#app/components/admin-launch-card.tsx'
import { AdminOrganizationDetail } from '#app/components/admin-organization-detail.tsx'
import { loadLaunchStatus } from '#app/utils/launch-status.server.ts'
import { type Route } from './+types/$organizationId.ts'

export async function loader({ request, params }: Route['LoaderArgs']) {
	await requireUserWithRole(request, 'admin')

	invariant(params.organizationId, 'Organization ID is required')

	// Get organization with detailed information
	const organization = await db.query.Organization.findFirst({
		where: eq(Organization.id, params.organizationId),
		with: {
			images: { limit: 1 },
			organizations: {
				with: {
					organizationRole: true,
					user: { with: { image: true } },
				},
				orderBy: desc(UserOrganization.createdAt),
			},
			organizationNotes: {
				with: { user: true },
				orderBy: desc(OrganizationNote.updatedAt),
				limit: 10,
			},
			integrations: true,
			sentInvitations: {
				with: { organizationRole: true, user: true },
				orderBy: desc(OrganizationInvitation.createdAt),
			},
		},
	})

	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}

	// The launch checklist, evaluated by the App (state and dates only).
	const launchPromise = loadLaunchStatus(params.organizationId)

	// Get recent activity (last 20 activities)
	const recentActivity = await db
		.select({
			id: NoteActivityLog.id,
			action: NoteActivityLog.action,
			createdAt: NoteActivityLog.createdAt,
			metadata: NoteActivityLog.metadata,
			user: { id: User.id, name: User.name, username: User.username },
			note: { id: OrganizationNote.id, title: OrganizationNote.title },
		})
		.from(NoteActivityLog)
		.innerJoin(
			OrganizationNote,
			eq(NoteActivityLog.noteId, OrganizationNote.id),
		)
		.innerJoin(User, eq(NoteActivityLog.userId, User.id))
		.where(eq(OrganizationNote.organizationId, params.organizationId))
		.orderBy(desc(NoteActivityLog.createdAt))
		.limit(20)

	return {
		organization: {
			...organization,
			image: organization.images[0] ?? null,
			users: organization.organizations.map((membership) => ({
				...membership,
				user: membership.user,
			})),
			notes: organization.organizationNotes.map((note) => ({
				...note,
				createdBy: note.user,
			})),
			invitations: organization.sentInvitations.map((invitation) => ({
				...invitation,
				inviter: invitation.user,
			})),
			memberCount: organization.organizations.filter((u) => u.active).length,
			totalMembers: organization.organizations.length,
			activeIntegrations: organization.integrations.filter((i) => i.isActive)
				.length,
			totalIntegrations: organization.integrations.length,
			pendingInvitations: organization.sentInvitations.filter(
				(i) => !i.expiresAt || i.expiresAt > new Date(),
			).length,
			_count: {
				users: organization.organizations.length,
				notes: organization.organizationNotes.length,
				integrations: organization.integrations.length,
				invitations: organization.sentInvitations.length,
			},
		},
		launch: await launchPromise,
		recentActivity: recentActivity.map((activity) => ({
			...activity,
			metadata: activity.metadata ? JSON.parse(activity.metadata) : null,
		})),
	}
}

export default function AdminOrganizationDetailPage() {
	const data = useLoaderData<typeof loader>()

	return (
		<div className="space-y-6">
			<AdminOrganizationDetail
				organization={data.organization}
				recentActivity={data.recentActivity}
			/>
			<AdminLaunchCard result={data.launch} />
		</div>
	)
}
