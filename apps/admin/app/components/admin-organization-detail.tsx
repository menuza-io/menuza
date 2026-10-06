import { Trans } from '@lingui/macro'
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { formatDistanceToNow } from 'date-fns'

export interface AdminOrganizationDetail {
	id: string
	name: string
	slug: string
	description: string | null
	active: boolean
	createdAt: Date
	updatedAt: Date
	planName: string | null
	subscriptionStatus: string | null
	size: string | null
	stripeCustomerId: string | null
	stripeSubscriptionId: string | null
	stripeProductId: string | null
	memberCount: number
	totalMembers: number
	activeIntegrations: number
	totalIntegrations: number
	pendingInvitations: number
	image?: {
		id: string
		altText: string | null
	} | null
	users: Array<{
		userId: string
		organizationRole: {
			id: string
			name: string
			level: number
		}
		active: boolean
		isDefault: boolean
		createdAt: Date
		updatedAt: Date
		department: string | null
		user: {
			id: string
			name: string | null
			email: string
			username: string
			image?: {
				id: string
				altText: string | null
			} | null
		}
	}>
	notes: Array<{
		id: string
		title: string
		createdAt: Date
		updatedAt: Date
		isPublic: boolean
		createdBy: {
			id: string
			name: string | null
			username: string
		}
	}>
	integrations: Array<{
		id: string
		providerName: string
		providerType: string
		isActive: boolean
		lastSyncAt: Date | null
		createdAt: Date
		updatedAt: Date
	}>
	invitations: Array<{
		id: string
		email: string
		organizationRole: {
			id: string
			name: string
			level: number
		}
		createdAt: Date
		expiresAt: Date | null
		inviter: {
			id: string
			name: string | null
			username: string
		} | null
	}>
	_count: {
		users: number
		notes: number
		integrations: number
		invitations: number
	}
}

export interface RecentActivity {
	id: string
	action: string
	createdAt: Date
	metadata: any
	user: {
		id: string
		name: string | null
		username: string
	}
	note: {
		id: string
		title: string
	}
}

interface AdminOrganizationDetailProps {
	organization: AdminOrganizationDetail
	recentActivity: RecentActivity[]
}

const getSubscriptionStatusBadge = (status: string | null) => {
	if (!status) {
		return <Badge variant="secondary">No Subscription</Badge>
	}

	switch (status.toLowerCase()) {
		case 'active':
			return <Badge variant="default">Active</Badge>
		case 'canceled':
		case 'cancelled':
			return <Badge variant="destructive">Canceled</Badge>
		case 'past_due':
			return <Badge variant="destructive">Past Due</Badge>
		case 'unpaid':
			return <Badge variant="destructive">Unpaid</Badge>
		case 'trialing':
			return <Badge variant="secondary">Trial</Badge>
		case 'incomplete':
			return <Badge variant="outline">Incomplete</Badge>
		default:
			return <Badge variant="outline">{status}</Badge>
	}
}

const getRoleBadge = (role: string) => {
	switch (role.toLowerCase()) {
		case 'owner':
			return <Badge variant="default">Owner</Badge>
		case 'admin':
			return <Badge variant="secondary">Admin</Badge>
		case 'member':
			return <Badge variant="outline">Member</Badge>
		default:
			return <Badge variant="outline">{role}</Badge>
	}
}

const getActivityIcon = (action: string) => {
	switch (action.toLowerCase()) {
		case 'created':
			return <Icon name="file-text" className="h-4 w-4 text-green-500" />
		case 'updated':
			return <Icon name="settings" className="h-4 w-4 text-blue-500" />
		case 'deleted':
			return <Icon name="activity" className="h-4 w-4 text-red-500" />
		default:
			return <Icon name="activity" className="text-muted-foreground h-4 w-4" />
	}
}

export function AdminOrganizationDetail({
	organization,
	recentActivity,
}: AdminOrganizationDetailProps) {
	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-start justify-between">
				<div className="flex items-center gap-4">
					<Avatar className="h-16 w-16">
						<AvatarImage
							src={
								organization.image?.id
									? `/resources/organization-images/${organization.image.id}`
									: undefined
							}
							alt={organization.image?.altText ?? organization.name}
						/>
						<AvatarFallback>
							<Icon name="blocks" className="h-8 w-8" />
						</AvatarFallback>
					</Avatar>
					<div>
						<h1 className="text-3xl font-bold tracking-tight">
							{organization.name}
						</h1>
						<p className="text-muted-foreground">@{organization.slug}</p>
						{organization.description && (
							<p className="text-muted-foreground mt-1 text-sm">
								{organization.description}
							</p>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Badge variant={organization.active ? 'default' : 'secondary'}>
						{organization.active ? 'Active' : 'Inactive'}
					</Badge>
					{organization.size && (
						<Badge variant="outline">{organization.size}</Badge>
					)}
				</div>
			</div>

			{/* Overview Cards */}
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Members</CardTitle>
						<Icon name="user-plus" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">{organization.memberCount}</div>
						<p className="text-muted-foreground text-xs">
							{organization.totalMembers !== organization.memberCount && (
								<span>{organization.totalMembers} total, </span>
							)}
							{organization.pendingInvitations > 0 && (
								<span>{organization.pendingInvitations} pending</span>
							)}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Notes</CardTitle>
						<Icon name="file-text" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{organization._count.notes}
						</div>
						<p className="text-muted-foreground text-xs">Total notes created</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Integrations</CardTitle>
						<Icon name="link-2" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{organization.activeIntegrations}
						</div>
						<p className="text-muted-foreground text-xs">
							{organization.totalIntegrations !==
								organization.activeIntegrations && (
								<span>{organization.totalIntegrations} total, </span>
							)}
							Active integrations
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Subscription</CardTitle>
						<Icon
							name="credit-card"
							className="text-muted-foreground h-4 w-4"
						/>
					</CardHeader>
					<CardContent>
						<div className="flex flex-col gap-1">
							{getSubscriptionStatusBadge(organization.subscriptionStatus)}
							{organization.planName && (
								<p className="text-muted-foreground text-xs">
									{organization.planName}
								</p>
							)}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Management Actions */}
			<div className="grid gap-4 md:grid-cols-3">
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="shield" className="h-5 w-5" />
							SSO Configuration
						</CardTitle>
						<CardDescription>
							Configure Single Sign-On authentication
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex gap-2">
							<Button variant="outline" size="sm">
								<a href={`/organizations/${organization.id}/sso`}>
									<Icon name="settings" className="mr-2 h-4 w-4" />
									Configure SSO
								</a>
							</Button>
							<Button variant="outline" size="sm">
								<a href={`/organizations/${organization.id}/sso/users`}>
									<Icon name="users" className="mr-2 h-4 w-4" />
									SSO Users
								</a>
							</Button>
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="settings" className="h-5 w-5" />
							Organization Settings
						</CardTitle>
						<CardDescription>Manage organization configuration</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" size="sm">
								<Icon name="edit" className="mr-2 h-4 w-4" />
								Edit Organization
							</Button>
							<Button
								variant="outline"
								size="sm"
								role="link"
								render={
									<a href={`/organizations/${organization.id}/chat-retention`}>
										<Trans>Message retention</Trans>
									</a>
								}
							/>
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="mail" className="h-5 w-5" />
							Invitations
						</CardTitle>
						<CardDescription>Manage pending invitations</CardDescription>
					</CardHeader>
					<CardContent>
						<Button variant="outline" size="sm">
							<Icon name="user-plus" className="mr-2 h-4 w-4" />
							Send Invitation
						</Button>
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				{/* Members */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="user-plus" className="h-5 w-5" />
							Members ({organization.users.length})
						</CardTitle>
						<CardDescription>
							Organization members and their roles
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							{organization.users.slice(0, 10).map((member) => (
								<div
									key={member.userId}
									className="flex items-center justify-between"
								>
									<div className="flex items-center gap-3">
										<Avatar className="h-8 w-8">
											<AvatarImage
												src={
													member.user.image?.id
														? `/resources/user-images/${member.user.image.id}`
														: undefined
												}
												alt={
													member.user.image?.altText ??
													member.user.name ??
													member.user.username
												}
											/>
											<AvatarFallback>
												{(member.user.name ?? member.user.username)
													.slice(0, 2)
													.toUpperCase()}
											</AvatarFallback>
										</Avatar>
										<div className="flex flex-col">
											<span className="text-sm font-medium">
												{member.user.name || member.user.username}
											</span>
											<span className="text-muted-foreground text-xs">
												{member.user.email}
											</span>
											{member.department && (
												<span className="text-muted-foreground text-xs">
													{member.department}
												</span>
											)}
										</div>
									</div>
									<div className="flex items-center gap-2">
										{getRoleBadge(member.organizationRole.name)}
										{!member.active && (
											<Badge variant="outline" className="text-xs">
												Inactive
											</Badge>
										)}
										{member.isDefault && (
											<Badge variant="outline" className="text-xs">
												Default
											</Badge>
										)}
									</div>
								</div>
							))}
							{organization.users.length > 10 && (
								<div className="text-center">
									<Button variant="outline" size="sm">
										View all {organization.users.length} members
									</Button>
								</div>
							)}
						</div>
					</CardContent>
				</Card>

				{/* Recent Notes */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="file-text" className="h-5 w-5" />
							Recent Notes ({organization.notes.length})
						</CardTitle>
						<CardDescription>Recently created or updated notes</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							{organization.notes.map((note) => (
								<div key={note.id} className="flex items-start justify-between">
									<div className="flex-1">
										<div className="flex items-center gap-2">
											<span className="line-clamp-1 text-sm font-medium">
												{note.title}
											</span>
											{!note.isPublic && (
												<Icon
													name="lock"
													className="text-muted-foreground h-3 w-3"
												/>
											)}
										</div>
										<div className="text-muted-foreground flex items-center gap-2 text-xs">
											<span>
												by {note.createdBy.name || note.createdBy.username}
											</span>
											<span>•</span>
											<span>
												{formatDistanceToNow(new Date(note.updatedAt), {
													addSuffix: true,
												})}
											</span>
										</div>
									</div>
								</div>
							))}
							{organization.notes.length === 0 && (
								<p className="text-muted-foreground py-4 text-center text-sm">
									No notes found
								</p>
							)}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Integrations and Activity */}
			<div className="grid gap-6 lg:grid-cols-2">
				{/* Integrations */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="link-2" className="h-5 w-5" />
							Integrations ({organization.integrations.length})
						</CardTitle>
						<CardDescription>
							Connected third-party integrations
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							{organization.integrations.map((integration) => (
								<div
									key={integration.id}
									className="flex items-center justify-between"
								>
									<div className="flex items-center gap-3">
										<div className="flex flex-col">
											<span className="text-sm font-medium capitalize">
												{integration.providerName}
											</span>
											<span className="text-muted-foreground text-xs">
												{integration.providerType}
											</span>
										</div>
									</div>
									<div className="flex items-center gap-2">
										<Badge
											variant={integration.isActive ? 'default' : 'secondary'}
										>
											{integration.isActive ? 'Active' : 'Inactive'}
										</Badge>
										{integration.lastSyncAt && (
											<span className="text-muted-foreground text-xs">
												Last sync:{' '}
												{formatDistanceToNow(new Date(integration.lastSyncAt), {
													addSuffix: true,
												})}
											</span>
										)}
									</div>
								</div>
							))}
							{organization.integrations.length === 0 && (
								<p className="text-muted-foreground py-4 text-center text-sm">
									No integrations configured
								</p>
							)}
						</div>
					</CardContent>
				</Card>

				{/* Recent Activity */}
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="activity" className="h-5 w-5" />
							Recent Activity
						</CardTitle>
						<CardDescription>Latest organization activity</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							{recentActivity.slice(0, 10).map((activity) => (
								<div key={activity.id} className="flex items-start gap-3">
									{getActivityIcon(activity.action)}
									<div className="flex-1 space-y-1">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium">
												{activity.user.name || activity.user.username}
											</span>
											<span className="text-muted-foreground text-sm">
												{activity.action}
											</span>
											<span className="text-sm font-medium">
												{activity.note.title}
											</span>
										</div>
										<div className="text-muted-foreground flex items-center gap-2 text-xs">
											<Icon name="clock" className="h-3 w-3" />
											<span>
												{formatDistanceToNow(new Date(activity.createdAt), {
													addSuffix: true,
												})}
											</span>
										</div>
									</div>
								</div>
							))}
							{recentActivity.length === 0 && (
								<p className="text-muted-foreground py-4 text-center text-sm">
									No recent activity
								</p>
							)}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Organization Details */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Icon name="settings" className="h-5 w-5" />
						Organization Details
					</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid gap-4 md:grid-cols-2">
						<div className="space-y-2">
							<div className="flex items-center gap-2">
								<Icon name="clock" className="text-muted-foreground h-4 w-4" />
								<span className="text-sm font-medium">Created:</span>
								<span className="text-muted-foreground text-sm">
									{new Date(organization.createdAt).toLocaleDateString()}
								</span>
							</div>
							<div className="flex items-center gap-2">
								<Icon name="clock" className="text-muted-foreground h-4 w-4" />
								<span className="text-sm font-medium">Updated:</span>
								<span className="text-muted-foreground text-sm">
									{new Date(organization.updatedAt).toLocaleDateString()}
								</span>
							</div>
						</div>
						<div className="space-y-2">
							{organization.stripeCustomerId && (
								<div className="flex items-center gap-2">
									<Icon
										name="credit-card"
										className="text-muted-foreground h-4 w-4"
									/>
									<span className="text-sm font-medium">Stripe Customer:</span>
									<span className="text-muted-foreground font-mono text-sm">
										{organization.stripeCustomerId}
									</span>
								</div>
							)}
							{organization.stripeSubscriptionId && (
								<div className="flex items-center gap-2">
									<Icon
										name="credit-card"
										className="text-muted-foreground h-4 w-4"
									/>
									<span className="text-sm font-medium">Subscription:</span>
									<span className="text-muted-foreground font-mono text-sm">
										{organization.stripeSubscriptionId}
									</span>
								</div>
							)}
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Pending Invitations */}
			{organization.invitations.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Icon name="mail" className="h-5 w-5" />
							Pending Invitations ({organization.invitations.length})
						</CardTitle>
						<CardDescription>
							Outstanding invitations to join the organization
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Email</TableHead>
									<TableHead>Role</TableHead>
									<TableHead>Invited By</TableHead>
									<TableHead>Sent</TableHead>
									<TableHead>Expires</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{organization.invitations.map((invitation) => (
									<TableRow key={invitation.id}>
										<TableCell className="font-medium">
											{invitation.email}
										</TableCell>
										<TableCell>
											{getRoleBadge(invitation.organizationRole.name)}
										</TableCell>
										<TableCell>
											{invitation.inviter?.name ||
												invitation.inviter?.username ||
												'System'}
										</TableCell>
										<TableCell>
											{formatDistanceToNow(new Date(invitation.createdAt), {
												addSuffix: true,
											})}
										</TableCell>
										<TableCell>
											{invitation.expiresAt ? (
												<span
													className={
														new Date(invitation.expiresAt) <= new Date()
															? 'text-red-500'
															: 'text-muted-foreground'
													}
												>
													{formatDistanceToNow(new Date(invitation.expiresAt), {
														addSuffix: true,
													})}
												</span>
											) : (
												<span className="text-muted-foreground">Never</span>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	)
}
