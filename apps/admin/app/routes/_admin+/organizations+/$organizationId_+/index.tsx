import { invariant } from '@epic-web/invariant'
import { requireUserWithRole } from '@repo/auth'
import {
	NoteActivityLog,
	Organization,
	OrganizationInvitation,
	OrganizationLocation,
	OrganizationNote,
	User,
	UserOrganization,
	db,
	desc,
	eq,
} from '@repo/database'
import { useLoaderData } from 'react-router'
import { AdminContactsCard } from '#app/components/admin-contacts-card.tsx'
import { AdminLaunchCard } from '#app/components/admin-launch-card.tsx'
import { AdminOrganizationDetail } from '#app/components/admin-organization-detail.tsx'
import { AdminOwnershipTransferCard } from '#app/components/admin-ownership-transfer-card.tsx'
import { OrganizationTabs } from '#app/components/organization-tabs.tsx'
import {
	listAssignments,
	listTeamMembers,
} from '#app/utils/assignments.server.ts'
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

	// Menuza contacts (#272) and the people the ownership transfer can name.
	const [assignments, team, locations] = await Promise.all([
		listAssignments(params.organizationId),
		listTeamMembers(),
		db
			.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, params.organizationId)),
	])

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
		contacts: {
			open: assignments.open.map(serializeAssignment),
			history: assignments.history.map(serializeAssignment),
			team,
			locations,
		},
		members: organization.organizations
			.filter((membership) => membership.active)
			.map((membership) => ({
				userId: membership.userId,
				name:
					membership.user.name || membership.user.username || membership.userId,
				roleName: membership.organizationRole.name,
				isAdmin: membership.organizationRoleId === 'org_role_admin',
			})),
		launch: await launchPromise,
		recentActivity: recentActivity.map((activity) => ({
			...activity,
			metadata: activity.metadata ? JSON.parse(activity.metadata) : null,
		})),
	}
}

function serializeAssignment(
	row: Awaited<ReturnType<typeof listAssignments>>['open'][number],
) {
	return {
		id: row.id,
		roleLabel: row.roleLabel,
		adminName: row.adminName,
		locationName: row.locationName,
		startedAt: row.startedAt.toISOString(),
		endedAt: row.endedAt?.toISOString() ?? null,
		assignedByName: row.assignedByName,
		endedByName: row.endedByName,
	}
}

export default function AdminOrganizationDetailPage() {
	const data = useLoaderData<typeof loader>()

	return (
		<div className="space-y-6">
			<div className="flex justify-end">
				<OrganizationTabs organizationId={data.organization.id} />
			</div>
			<AdminOrganizationDetail
				organization={data.organization}
				recentActivity={data.recentActivity}
			/>
			<AdminLaunchCard result={data.launch} />
			<AdminContactsCard
				organizationId={data.organization.id}
				open={data.contacts.open}
				history={data.contacts.history}
				team={data.contacts.team}
				locations={data.contacts.locations}
			/>
			<AdminOwnershipTransferCard
				organizationId={data.organization.id}
				members={data.members}
			/>
		</div>
	)
}
