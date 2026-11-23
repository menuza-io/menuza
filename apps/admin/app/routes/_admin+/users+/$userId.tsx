import { invariantResponse } from '@epic-web/invariant'
import { getCallerVerificationState, requireUserWithRole } from '@repo/auth'
import { getIpAddressesByUser } from '@repo/common/ip-tracking'
import {
	NoteActivityLog,
	NoteComment,
	User,
	db,
	desc,
	eq,
} from '@repo/database'
import { useLoaderData } from 'react-router'
import { type CallerVerificationView } from '#app/components/admin-support-card.tsx'
import {
	UserDetailView,
	type AdminUserDetail,
	type RecentActivity,
} from '#app/components/admin-user-detail.tsx'

export async function loader({
	request,
	params,
}: {
	request: Request
	params: { userId: string }
}) {
	const agentId = await requireUserWithRole(request, 'admin')

	const { userId } = params
	invariantResponse(userId, 'User ID is required')

	// Get comprehensive user data
	const result = await db.query.User.findFirst({
		where: eq(User.id, userId),
		with: {
			user: true,
			image: true,
			organizations: {
				with: { organizationRole: true, organization: true },
				orderBy: (membership, { desc }) => desc(membership.createdAt),
			},
			sessions: {
				limit: 10,
				orderBy: (session, { desc }) => desc(session.createdAt),
			},
			connections: {
				orderBy: (connection, { desc }) => desc(connection.createdAt),
			},
			roleToUsers: { with: { role: true } },
			notes: {
				limit: 5,
				orderBy: (note, { desc }) => desc(note.updatedAt),
			},
			password: true,
		},
	})
	const user = result
		? {
				...result,
				bannedBy: result.user,
				roles: result.roleToUsers.map(({ role }) => role),
			}
		: null

	invariantResponse(user, 'User not found', { status: 404 })

	// Get activity data (recent notes, comments, etc.)
	const [recentNoteComments, recentActivityLogs] = await Promise.all([
		db.query.NoteComment.findMany({
			where: eq(NoteComment.userId, user.id),
			with: { note: true },
			orderBy: desc(NoteComment.createdAt),
			limit: 5,
		}),
		db.query.NoteActivityLog.findMany({
			where: eq(NoteActivityLog.userId, user.id),
			with: { note: true },
			orderBy: desc(NoteActivityLog.createdAt),
			limit: 10,
		}),
	])

	// Get IP addresses used by this user
	const userIpAddresses = await getIpAddressesByUser(user.id)

	const verification = await getCallerVerificationState({ agentId, userId })

	return Response.json({
		verification,
		user: {
			...user,
			hasPassword: !!user.password,
		},
		recentActivity: {
			comments: recentNoteComments,
			activityLogs: recentActivityLogs,
		},
		ipAddresses: userIpAddresses,
	})
}

type LoaderData = {
	verification: CallerVerificationView
	user: AdminUserDetail
	recentActivity: RecentActivity
	ipAddresses: Awaited<ReturnType<typeof getIpAddressesByUser>>
}

export default function AdminUserDetailPage() {
	const data = useLoaderData() as LoaderData

	return (
		<div className="space-y-6">
			<UserDetailView
				user={data.user}
				recentActivity={data.recentActivity}
				ipAddresses={data.ipAddresses}
				verification={data.verification}
			/>
		</div>
	)
}
