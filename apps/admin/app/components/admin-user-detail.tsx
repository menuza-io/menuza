import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getUserImgSrc } from '@repo/common'
import { type getIpAddressesByUser } from '@repo/common/ip-tracking'
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
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useState, useMemo } from 'react'
import { useNavigate, useSubmit } from 'react-router'
import { BanUserDialog } from '#app/components/admin-ban-user-dialog.tsx'
import {
	AdminSupportCard,
	type CallerVerificationView,
} from '#app/components/admin-support-card.tsx'

export interface AdminUserDetail {
	id: string
	name: string | null
	email: string
	username: string
	createdAt: string
	updatedAt: string
	hasPassword: boolean
	isBanned: boolean
	banReason: string | null
	banExpiresAt: string | null
	bannedAt: string | null
	bannedBy?: {
		id: string
		name: string | null
		username: string
	} | null
	image?: {
		id: string
		altText: string | null
	} | null
	organizations: Array<{
		organizationRole: {
			id: string
			name: string
			level: number
		}
		active: boolean
		isDefault: boolean
		createdAt: string
		department: string | null
		organization: {
			id: string
			name: string
			slug: string
			description: string | null
			active: boolean
			subscriptionStatus: string | null
			planName: string | null
		}
	}>
	sessions: Array<{
		id: string
		createdAt: string
		expirationDate: string
	}>
	connections: Array<{
		id: string
		providerName: string
		providerId: string
		createdAt: string
	}>
	roles: Array<{
		id: string
		name: string
		description: string
	}>
	notes: Array<{
		id: string
		title: string
		createdAt: string
		updatedAt: string
	}>
}

export interface RecentActivity {
	comments: Array<{
		id: string
		content: string
		createdAt: string
		note: {
			id: string
			title: string
		}
	}>
	activityLogs: Array<{
		id: string
		action: string
		createdAt: string
		note: {
			id: string
			title: string
		}
	}>
}

interface UserDetailViewProps {
	user: AdminUserDetail
	recentActivity: RecentActivity
	ipAddresses: Awaited<ReturnType<typeof getIpAddressesByUser>>
	verification: CallerVerificationView
}

export function UserDetailView({
	user,
	recentActivity,
	ipAddresses,
	verification,
}: UserDetailViewProps) {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const submit = useSubmit()
	const [showBanDialog, setShowBanDialog] = useState(false)

	const handleBanUser = () => {
		setShowBanDialog(true)
	}

	const handleLiftBan = () => {
		const formData = new FormData()
		formData.append('intent', 'lift-ban')

		void submit(formData, {
			method: 'POST',
			action: `/users/${user.id}/ban`,
		})
	}

	const handleImpersonateUser = () => {
		const formData = new FormData()
		void submit(formData, {
			method: 'POST',
			action: `/users/${user.id}/impersonate`,
		})
	}

	// Check if ban is expired
	const isBanExpired =
		user.isBanned &&
		user.banExpiresAt &&
		new Date(user.banExpiresAt) <= new Date()

	const activeSessions = useMemo(
		() =>
			user.sessions.filter(
				(session) => new Date(session.expirationDate) > new Date(),
			),
		[user.sessions],
	)

	const activeCount = user.organizations.filter((org) => org.active).length
	const totalSessions = user.sessions.length

	return (
		<>
			<div className="space-y-6">
				{/* Header */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-4">
						<div className="flex items-center gap-3">
							<Avatar className="h-12 w-12">
								<AvatarImage
									src={getUserImgSrc(user.image?.id)}
									alt={user.image?.altText ?? user.name ?? user.username}
								/>
								<AvatarFallback>
									{(user.name ?? user.username).slice(0, 2).toUpperCase()}
								</AvatarFallback>
							</Avatar>
							<div>
								<div className="flex items-center gap-2">
									<h1 className="text-2xl font-bold">
										{user.name || user.username}
									</h1>
									{user.isBanned && (
										<Badge variant="destructive" className="gap-1">
											<Icon name="ban" className="h-3 w-3" />
											{isBanExpired ? (
												<Trans>Ban Expired</Trans>
											) : (
												<Trans>Banned</Trans>
											)}
										</Badge>
									)}
								</div>
								<p className="text-muted-foreground">{user.email}</p>
								{user.isBanned && user.banReason && (
									<p className="text-destructive mt-1 text-sm">
										<Icon
											name="alert-triangle"
											className="mr-1 inline h-4 w-4"
										/>
										{user.banReason}
									</p>
								)}
							</div>
						</div>
					</div>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleImpersonateUser}
							className="gap-2"
							disabled={user.isBanned && !isBanExpired}
						>
							<Icon name="user" className="h-4 w-4" />
							<Trans>Impersonate</Trans>
						</Button>
						{user.isBanned ? (
							<Button
								variant="outline"
								size="sm"
								onClick={handleLiftBan}
								className="gap-2"
							>
								<Icon name="shield-check" className="h-4 w-4" />
								<Trans>Lift Ban</Trans>
							</Button>
						) : (
							<Button
								variant="destructive"
								size="sm"
								onClick={handleBanUser}
								className="gap-2"
							>
								<Icon name="ban" className="h-4 w-4" />
								<Trans>Ban User</Trans>
							</Button>
						)}
					</div>
				</div>

				{/* Overview Cards */}
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								<Trans>Organizations</Trans>
							</CardTitle>
							<Icon name="building" className="text-muted-foreground h-4 w-4" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{user.organizations.length}
							</div>
							<p className="text-muted-foreground text-xs">
								<Trans>{activeCount} active</Trans>
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								<Trans>Active Sessions</Trans>
							</CardTitle>
							<Icon name="key" className="text-muted-foreground h-4 w-4" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">{activeSessions.length}</div>
							<p className="text-muted-foreground text-xs">
								<Trans>{totalSessions} total sessions</Trans>
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								<Trans>Notes Created</Trans>
							</CardTitle>
							<Icon
								name="file-text"
								className="text-muted-foreground h-4 w-4"
							/>
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">{user.notes.length}</div>
							<p className="text-muted-foreground text-xs">
								<Trans>Recent notes shown</Trans>
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								<Trans>Security</Trans>
							</CardTitle>
							<Icon name="shield" className="text-muted-foreground h-4 w-4" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{user.hasPassword ? '✓' : '✗'}
							</div>
							<p className="text-muted-foreground text-xs">
								<Trans>0 passkeys</Trans>
							</p>
						</CardContent>
					</Card>
				</div>

				<AdminSupportCard
					userId={user.id}
					verification={verification}
					memberships={user.organizations
						.filter((org) => org.active)
						.map((org) => ({
							organization: org.organization.name,
							role: org.organizationRole.name,
						}))}
				/>

				{/* Detailed Information */}
				<Tabs defaultValue="overview" className="space-y-4">
					<TabsList>
						<TabsTrigger value="overview">
							<Trans>Overview</Trans>
						</TabsTrigger>
						<TabsTrigger value="organizations">
							<Trans>Organizations</Trans>
						</TabsTrigger>
						<TabsTrigger value="activity">
							<Trans>Activity</Trans>
						</TabsTrigger>
						<TabsTrigger value="security">
							<Trans>Security</Trans>
						</TabsTrigger>
						<TabsTrigger value="ip-addresses">
							<Trans>IP Addresses</Trans>
						</TabsTrigger>
					</TabsList>

					<TabsContent value="overview" className="space-y-4">
						{user.isBanned && (
							<Card className="border-destructive">
								<CardHeader>
									<CardTitle className="text-destructive flex items-center gap-2">
										<Icon name="ban" className="h-5 w-5" />
										<Trans>Ban Information</Trans>
									</CardTitle>
								</CardHeader>
								<CardContent className="space-y-3">
									<div className="grid gap-2">
										<div className="flex items-center gap-2 text-sm">
											<span className="font-medium">
												<Trans>Status:</Trans>
											</span>
											<Badge variant="destructive">
												{isBanExpired ? (
													<Trans>Ban Expired</Trans>
												) : (
													<Trans>Banned</Trans>
												)}
											</Badge>
										</div>
										{user.banReason && (
											<div className="flex items-start gap-2 text-sm">
												<span className="font-medium">
													<Trans>Reason:</Trans>
												</span>
												<span className="flex-1">{user.banReason}</span>
											</div>
										)}
										{user.bannedAt && (
											<div className="flex items-center gap-2 text-sm">
												<span className="font-medium">
													<Trans>Banned:</Trans>
												</span>
												<span>{new Date(user.bannedAt).toLocaleString()}</span>
											</div>
										)}
										{user.banExpiresAt && (
											<div className="flex items-center gap-2 text-sm">
												<span className="font-medium">
													<Trans>Expires:</Trans>
												</span>
												<span
													className={
														isBanExpired ? 'text-muted-foreground' : ''
													}
												>
													{new Date(user.banExpiresAt).toLocaleString()}
													{isBanExpired && (
														<>
															{' '}
															<Trans>(Expired)</Trans>
														</>
													)}
												</span>
											</div>
										)}
										{user.bannedBy && (
											<div className="flex items-center gap-2 text-sm">
												<span className="font-medium">
													<Trans>Banned by:</Trans>
												</span>
												<span>
													{user.bannedBy.name || user.bannedBy.username}
												</span>
											</div>
										)}
									</div>
								</CardContent>
							</Card>
						)}
						<div className="grid gap-4 md:grid-cols-2">
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<Icon name="user" className="h-5 w-5" />
										User Information
									</CardTitle>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="grid gap-2">
										<div className="flex items-center gap-2 text-sm">
											<Icon
												name="mail"
												className="text-muted-foreground h-4 w-4"
											/>
											<span className="font-medium">Email:</span>
											<span>{user.email}</span>
										</div>
										<div className="flex items-center gap-2 text-sm">
											<Icon
												name="user"
												className="text-muted-foreground h-4 w-4"
											/>
											<span className="font-medium">Username:</span>
											<span className="font-mono">{user.username}</span>
										</div>
										<div className="flex items-center gap-2 text-sm">
											<Icon
												name="calendar"
												className="text-muted-foreground h-4 w-4"
											/>
											<span className="font-medium">Created:</span>
											<span>
												{new Date(user.createdAt).toLocaleDateString()}
											</span>
										</div>
										<div className="flex items-center gap-2 text-sm">
											<Icon
												name="calendar"
												className="text-muted-foreground h-4 w-4"
											/>
											<span className="font-medium">Updated:</span>
											<span>
												{new Date(user.updatedAt).toLocaleDateString()}
											</span>
										</div>
									</div>
								</CardContent>
							</Card>

							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<Icon name="shield" className="h-5 w-5" />
										Roles & Permissions
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										{user.roles.length > 0 ? (
											user.roles.map((role) => (
												<div
													key={role.id}
													className="flex items-center justify-between"
												>
													<Badge variant="secondary">{role.name}</Badge>
													<span className="text-muted-foreground text-xs">
														{role.description}
													</span>
												</div>
											))
										) : (
											<p className="text-muted-foreground text-sm">
												No roles assigned
											</p>
										)}
									</div>
								</CardContent>
							</Card>
						</div>
					</TabsContent>

					<TabsContent value="organizations" className="space-y-4">
						<Card>
							<CardHeader>
								<CardTitle>Organization Memberships</CardTitle>
								<CardDescription>
									Organizations this user belongs to
								</CardDescription>
							</CardHeader>
							<CardContent>
								{user.organizations.length > 0 ? (
									<ItemGroup>
										{user.organizations.map((membership) => (
											<Item key={membership.organization.id} variant="outline">
												<ItemContent>
													<ItemTitle>
														{membership.organization.name}
														{membership.isDefault && (
															<Badge variant="outline" className="text-xs">
																Default
															</Badge>
														)}
														{!membership.active && (
															<Badge variant="destructive" className="text-xs">
																Inactive
															</Badge>
														)}
													</ItemTitle>
													<ItemDescription>
														{membership.organization.description ||
															'No description'}
													</ItemDescription>
													<ItemDescription className="flex items-center gap-4">
														<span>
															Role: {membership.organizationRole.name}
														</span>
														{membership.department && (
															<span>Department: {membership.department}</span>
														)}
														<span>
															Joined:{' '}
															{new Date(
																membership.createdAt,
															).toLocaleDateString()}
														</span>
													</ItemDescription>
												</ItemContent>
												<ItemActions>
													{membership.organization.subscriptionStatus && (
														<Badge variant="outline">
															{membership.organization.subscriptionStatus}
														</Badge>
													)}
													<Button
														variant="ghost"
														size="sm"
														onClick={() =>
															navigate(
																`/organizations/${membership.organization.id}`,
															)
														}
													>
														<Icon name="external-link" className="h-4 w-4" />
													</Button>
												</ItemActions>
											</Item>
										))}
									</ItemGroup>
								) : (
									<p className="text-muted-foreground text-sm">
										<Trans>User is not a member of any organizations</Trans>
									</p>
								)}
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="activity" className="space-y-4">
						<div className="grid gap-4 md:grid-cols-2">
							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<Icon name="message-circle" className="h-5 w-5" />
										<Trans>Recent Comments</Trans>
									</CardTitle>
								</CardHeader>
								<CardContent>
									{recentActivity.comments.length > 0 ? (
										<ItemGroup>
											{recentActivity.comments.map((comment) => (
												<Item key={comment.id} variant="outline">
													<ItemContent>
														<ItemTitle>{comment.content}</ItemTitle>
														<ItemDescription>
															On: {comment.note.title} •{' '}
															{new Date(comment.createdAt).toLocaleDateString()}
														</ItemDescription>
													</ItemContent>
												</Item>
											))}
										</ItemGroup>
									) : (
										<p className="text-muted-foreground text-sm">
											<Trans>No recent comments</Trans>
										</p>
									)}
								</CardContent>
							</Card>

							<Card>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<Icon name="activity" className="h-5 w-5" />
										<Trans>Recent Activity</Trans>
									</CardTitle>
								</CardHeader>
								<CardContent>
									{recentActivity.activityLogs.length > 0 ? (
										<ItemGroup>
											{recentActivity.activityLogs.map((log) => (
												<Item key={log.id} variant="outline">
													<ItemContent>
														<ItemTitle>{log.action}</ItemTitle>
														<ItemDescription>
															On: {log.note.title} •{' '}
															{new Date(log.createdAt).toLocaleDateString()}
														</ItemDescription>
													</ItemContent>
												</Item>
											))}
										</ItemGroup>
									) : (
										<p className="text-muted-foreground text-sm">
											<Trans>No recent activity</Trans>
										</p>
									)}
								</CardContent>
							</Card>
						</div>

						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<Icon name="file-text" className="h-5 w-5" />
									<Trans>Recent Notes</Trans>
								</CardTitle>
							</CardHeader>
							<CardContent>
								{user.notes.length > 0 ? (
									<ItemGroup>
										{user.notes.map((note) => (
											<Item key={note.id} variant="outline">
												<ItemContent>
													<ItemTitle>{note.title}</ItemTitle>
													<ItemDescription>
														Created:{' '}
														{new Date(note.createdAt).toLocaleDateString()} •
														Updated:{' '}
														{new Date(note.updatedAt).toLocaleDateString()}
													</ItemDescription>
												</ItemContent>
											</Item>
										))}
									</ItemGroup>
								) : (
									<p className="text-muted-foreground text-sm">
										<Trans>No notes created</Trans>
									</p>
								)}
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="security" className="space-y-4">
						<div className="grid gap-4 md:grid-cols-2">
							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Authentication Methods</Trans>
									</CardTitle>
								</CardHeader>
								<CardContent className="space-y-4">
									<div className="flex items-center justify-between">
										<span className="text-sm">
											<Trans>Password</Trans>
										</span>
										<Badge variant={user.hasPassword ? 'default' : 'secondary'}>
											{user.hasPassword ? _(msg`Set`) : _(msg`Not Set`)}
										</Badge>
									</div>
									<div className="flex items-center justify-between">
										<span className="text-sm">
											<Trans>Passkeys</Trans>
										</span>
										<Badge variant="secondary">
											<Trans>0 configured</Trans>
										</Badge>
									</div>
								</CardContent>
							</Card>

							<Card>
								<CardHeader>
									<CardTitle>
										<Trans>Connected Accounts</Trans>
									</CardTitle>
								</CardHeader>
								<CardContent>
									{user.connections.length > 0 ? (
										<ItemGroup>
											{user.connections.map((connection) => (
												<Item key={connection.id} variant="outline">
													<ItemContent>
														<ItemTitle>
															<Badge variant="outline">
																{connection.providerName}
															</Badge>
															<span className="font-mono text-sm font-normal">
																{connection.providerId}
															</span>
														</ItemTitle>
														<ItemDescription>
															{new Date(
																connection.createdAt,
															).toLocaleDateString()}
														</ItemDescription>
													</ItemContent>
												</Item>
											))}
										</ItemGroup>
									) : (
										<p className="text-muted-foreground text-sm">
											<Trans>No connected accounts</Trans>
										</p>
									)}
								</CardContent>
							</Card>
						</div>

						<Card>
							<CardHeader>
								<CardTitle>
									<Trans>Active Sessions</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>Current active login sessions</Trans>
								</CardDescription>
							</CardHeader>
							<CardContent>
								{activeSessions.length > 0 ? (
									<ItemGroup>
										{activeSessions.map((session) => {
											const sessionId = session.id.slice(0, 8)
											const createdAt = new Date(
												session.createdAt,
											).toLocaleString()
											const expiresAt = new Date(
												session.expirationDate,
											).toLocaleString()
											return (
												<Item key={session.id} variant="outline">
													<ItemContent>
														<ItemTitle>
															<Trans>Session {sessionId}...</Trans>
														</ItemTitle>
														<ItemDescription>
															<Trans>Created: {createdAt}</Trans>
														</ItemDescription>
													</ItemContent>
													<ItemActions>
														<span className="text-muted-foreground text-xs">
															<Trans>Expires: {expiresAt}</Trans>
														</span>
													</ItemActions>
												</Item>
											)
										})}
									</ItemGroup>
								) : (
									<p className="text-muted-foreground text-sm">
										<Trans>No active sessions</Trans>
									</p>
								)}
							</CardContent>
						</Card>
					</TabsContent>

					<TabsContent value="ip-addresses" className="space-y-4">
						<Card>
							<CardHeader>
								<CardTitle>
									<Trans>IP Addresses</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>IP addresses used by this user</Trans>
								</CardDescription>
							</CardHeader>
							<CardContent>
								{ipAddresses.length > 0 ? (
									<ItemGroup>
										{ipAddresses.map((conn) => {
											const lastSeenAt = new Date(
												conn.lastSeenAt,
											).toLocaleString()
											return (
												<Item key={conn.id} variant="outline">
													<ItemContent>
														<ItemTitle className="font-mono">
															{conn.ipAddress.ip}
														</ItemTitle>
														<ItemDescription>
															{conn.ipAddress.city}, {conn.ipAddress.region},{' '}
															{conn.ipAddress.country}
														</ItemDescription>
													</ItemContent>
													<ItemActions>
														<span className="text-muted-foreground text-xs">
															<Trans>Last Seen: {lastSeenAt}</Trans>
														</span>
													</ItemActions>
												</Item>
											)
										})}
									</ItemGroup>
								) : (
									<p className="text-muted-foreground text-sm">
										<Trans>No IP addresses recorded for this user</Trans>
									</p>
								)}
							</CardContent>
						</Card>
					</TabsContent>
				</Tabs>
			</div>

			<BanUserDialog
				user={user}
				isOpen={showBanDialog}
				onClose={() => setShowBanDialog(false)}
			/>
		</>
	)
}
