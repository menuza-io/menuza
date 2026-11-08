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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { formatDistanceToNow } from 'date-fns'

interface SSOUser {
	id: string
	name: string | null
	email: string
	username: string
	image?: {
		id: string
		altText: string | null
	} | null
	organizationRole: {
		id: string
		name: string
		level: number
	}
	active: boolean
	isDefault: boolean
	department: string | null
	createdAt: Date
	updatedAt: Date
	// SSO-specific data
	// Linked to an account at this organization's identity provider.
	ssoLinked?: boolean
	ssoSessions: Array<{
		id: string
		providerUserId: string
		createdAt: Date
		updatedAt: Date
		ssoConfig: {
			providerName: string
		}
	}>
}

interface SSOAuditLog {
	id: string
	action: string
	createdAt: Date
	metadata: any
	user: {
		id: string
		name: string | null
		username: string
	}
	details: string
}

interface SSOUserManagementProps {
	organizationId: string
	ssoUsers: SSOUser[]
	auditLogs: SSOAuditLog[]
	availableRoles: Array<{
		id: string
		name: string
		level: number
	}>
	onRoleChange?: (userId: string, roleId: string) => void
	onUserStatusChange?: (userId: string, active: boolean) => void
	onResetLink?: (userId: string) => void
}

const getRoleBadge = (role: string, _level: number) => {
	switch (role.toLowerCase()) {
		case 'owner':
			return (
				<Badge variant="default">
					<Trans>Owner</Trans>
				</Badge>
			)
		case 'admin':
			return (
				<Badge variant="secondary">
					<Trans>Admin</Trans>
				</Badge>
			)
		case 'member':
			return (
				<Badge variant="outline">
					<Trans>Member</Trans>
				</Badge>
			)
		default:
			return <Badge variant="outline">{role}</Badge>
	}
}

const getActionIcon = (action: string) => {
	switch (action.toLowerCase()) {
		case 'sso_login':
			return <Icon name="user" className="h-4 w-4 text-green-500" />
		case 'sso_logout':
			return <Icon name="log-out" className="h-4 w-4 text-blue-500" />
		case 'sso_user_created':
			return <Icon name="user-plus" className="h-4 w-4 text-green-500" />
		case 'sso_user_updated':
			return <Icon name="check" className="h-4 w-4 text-blue-500" />
		case 'sso_config_updated':
			return <Icon name="settings" className="h-4 w-4 text-orange-500" />
		case 'sso_config_enabled':
			return <Icon name="check-circle" className="h-4 w-4 text-green-500" />
		case 'sso_config_disabled':
			return <Icon name="ban" className="h-4 w-4 text-red-500" />
		default:
			return <Icon name="activity" className="text-muted-foreground h-4 w-4" />
	}
}

export function SSOUserManagement({
	organizationId: _organizationId,
	ssoUsers,
	auditLogs,
	availableRoles,
	onRoleChange,
	onUserStatusChange,
	onResetLink,
}: SSOUserManagementProps) {
	const userCount = ssoUsers.length
	const activeCount = ssoUsers.filter((u) => u.active).length
	return (
		<div className="space-y-6">
			{/* SSO Users Table */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Icon name="users" className="h-5 w-5" />
						<Trans>SSO Users ({userCount})</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Users who have authenticated through SSO</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{ssoUsers.length > 0 ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>User</Trans>
									</TableHead>
									<TableHead>
										<Trans>Role</Trans>
									</TableHead>
									<TableHead>
										<Trans>SSO Provider</Trans>
									</TableHead>
									<TableHead>
										<Trans>Last SSO Login</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
									<TableHead>
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{ssoUsers.map((user) => {
									const latestSSOSession = user.ssoSessions[0] // Assuming sorted by most recent
									return (
										<TableRow key={user.id}>
											<TableCell>
												<div className="flex items-center gap-3">
													<Avatar className="h-8 w-8">
														<AvatarImage
															src={
																user.image?.id
																	? `/resources/user-images/${user.image.id}`
																	: undefined
															}
															alt={
																user.image?.altText ??
																user.name ??
																user.username
															}
														/>
														<AvatarFallback>
															{(user.name ?? user.username)
																.slice(0, 2)
																.toUpperCase()}
														</AvatarFallback>
													</Avatar>
													<div className="flex flex-col">
														<span className="font-medium">
															{user.name || user.username}
														</span>
														<span className="text-muted-foreground text-sm">
															{user.email}
														</span>
														{user.department && (
															<span className="text-muted-foreground text-xs">
																{user.department}
															</span>
														)}
													</div>
												</div>
											</TableCell>
											<TableCell>
												<div className="flex items-center gap-2">
													{getRoleBadge(
														user.organizationRole.name,
														user.organizationRole.level,
													)}
													{user.isDefault && (
														<Badge variant="outline" className="text-xs">
															<Trans>Default</Trans>
														</Badge>
													)}
												</div>
											</TableCell>
											<TableCell>
												{latestSSOSession ? (
													<Badge variant="outline">
														{latestSSOSession.ssoConfig.providerName}
													</Badge>
												) : (
													<span className="text-muted-foreground text-sm">
														<Trans>No SSO sessions</Trans>
													</span>
												)}
											</TableCell>
											<TableCell>
												{latestSSOSession ? (
													<span className="text-muted-foreground text-sm">
														{formatDistanceToNow(
															new Date(latestSSOSession.updatedAt),
															{
																addSuffix: true,
															},
														)}
													</span>
												) : (
													<span className="text-muted-foreground text-sm">
														<Trans>Never</Trans>
													</span>
												)}
											</TableCell>
											<TableCell>
												<Badge variant={user.active ? 'default' : 'secondary'}>
													{user.active ? (
														<Trans>Active</Trans>
													) : (
														<Trans>Inactive</Trans>
													)}
												</Badge>
											</TableCell>
											<TableCell>
												<div className="flex items-center gap-2">
													<Select
														defaultValue={user.organizationRole.id}
														onValueChange={(roleId) =>
															onRoleChange?.(user.id, roleId as string)
														}
													>
														<SelectTrigger className="w-32">
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{availableRoles.map((role) => (
																<SelectItem key={role.id} value={role.id}>
																	{role.name}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
													<Button
														size="sm"
														variant="outline"
														onClick={() =>
															onUserStatusChange?.(user.id, !user.active)
														}
													>
														{user.active ? (
															<Trans>Deactivate</Trans>
														) : (
															<Trans>Activate</Trans>
														)}
													</Button>
													{user.ssoLinked && onResetLink ? (
														<Button
															size="sm"
															variant="outline"
															onClick={() => onResetLink(user.id)}
														>
															<Trans>Reset SSO link</Trans>
														</Button>
													) : null}
												</div>
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					) : (
						<div className="py-8 text-center">
							<Icon
								name="users"
								className="text-muted-foreground mx-auto h-12 w-12"
							/>
							<h3 className="mt-4 text-lg font-medium">
								<Trans>No SSO Users</Trans>
							</h3>
							<p className="text-muted-foreground mt-2">
								<Trans>No users have authenticated through SSO yet.</Trans>
							</p>
						</div>
					)}
				</CardContent>
			</Card>

			{/* SSO Audit Trail */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Icon name="file-text" className="h-5 w-5" />
						<Trans>SSO Audit Trail</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Recent SSO configuration changes and user activities</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{auditLogs.length > 0 ? (
						<div className="space-y-4">
							{auditLogs.map((log) => (
								<div
									key={log.id}
									className="flex items-start gap-3 border-b pb-4 last:border-b-0"
								>
									{getActionIcon(log.action)}
									<div className="flex-1 space-y-1">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium">
												{log.user.name || log.user.username}
											</span>
											<span className="text-muted-foreground text-sm">
												{log.details}
											</span>
										</div>
										<div className="text-muted-foreground flex items-center gap-2 text-xs">
											<Icon name="clock" className="h-3 w-3" />
											<span>
												{formatDistanceToNow(new Date(log.createdAt), {
													addSuffix: true,
												})}
											</span>
										</div>
										{log.metadata && (
											<details className="text-muted-foreground text-xs">
												<summary className="cursor-pointer">
													<Trans>View details</Trans>
												</summary>
												<pre className="bg-muted mt-2 overflow-x-auto rounded p-2 text-xs">
													{JSON.stringify(log.metadata, null, 2)}
												</pre>
											</details>
										)}
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="py-8 text-center">
							<Icon
								name="file-text"
								className="text-muted-foreground mx-auto h-12 w-12"
							/>
							<h3 className="mt-4 text-lg font-medium">
								<Trans>No Audit Logs</Trans>
							</h3>
							<p className="text-muted-foreground mt-2">
								<Trans>No SSO activities have been recorded yet.</Trans>
							</p>
						</div>
					)}
				</CardContent>
			</Card>

			{/* SSO Statistics */}
			<div className="grid gap-4 md:grid-cols-3">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Total SSO Users</Trans>
						</CardTitle>
						<Icon name="users" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">{ssoUsers.length}</div>
						<p className="text-muted-foreground text-xs">
							<Trans>{activeCount} active</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Recent Logins</Trans>
						</CardTitle>
						<Icon name="user" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{
								auditLogs.filter(
									(log) =>
										log.action === 'sso_login' &&
										new Date(log.createdAt) >
											new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
								).length
							}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Last 7 days</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Config Changes</Trans>
						</CardTitle>
						<Icon name="settings" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{
								auditLogs.filter(
									(log) =>
										log.action.startsWith('sso_config') &&
										new Date(log.createdAt) >
											new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
								).length
							}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Last 30 days</Trans>
						</p>
					</CardContent>
				</Card>
			</div>
		</div>
	)
}
