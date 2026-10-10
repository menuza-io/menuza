import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getUserId, requireUserWithRole } from '@repo/auth'
import { blacklistIp, unblacklistIp } from '@repo/common/ip-tracking'
import {
	IpAddress,
	IpAddressUser,
	and,
	count,
	db,
	desc,
	eq,
	gt,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Textarea } from '@repo/ui/textarea'
import {
	useLoaderData,
	Form,
	type LoaderFunctionArgs,
	type ActionFunctionArgs,
	Link,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')

	const url = new URL(request.url)
	const page = parseInt(url.searchParams.get('page') || '1', 10)
	const pageSize = 20

	const results = await db.query.IpAddress.findMany({
		with: {
			user: true,
			ipAddressUsers: {
				with: { user: true },
				orderBy: desc(IpAddressUser.lastSeenAt),
				limit: 5,
			},
		},
		orderBy: desc(IpAddress.createdAt),
		offset: (page - 1) * pageSize,
		limit: pageSize,
	})
	const ipAddresses = results.map((result) => ({
		...result,
		blacklistedBy: result.user,
	}))

	const [total, blacklisted, suspicious] = await Promise.all([
		db.select({ count: count() }).from(IpAddress),
		db
			.select({ count: count() })
			.from(IpAddress)
			.where(eq(IpAddress.isBlacklisted, true)),
		db
			.select({ count: count() })
			.from(IpAddress)
			.where(
				and(
					gt(IpAddress.suspiciousScore, 0),
					eq(IpAddress.isBlacklisted, false),
				),
			),
	])
	const totalCount = total[0]?.count ?? 0
	const blacklistedCount = blacklisted[0]?.count ?? 0
	const suspiciousCount = suspicious[0]?.count ?? 0

	return {
		ipAddresses,
		stats: {
			totalIps: totalCount,
			blacklistedIps: blacklistedCount,
			suspiciousIps: suspiciousCount,
		},
	}
}

export async function action({ request }: ActionFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const userId = await getUserId(request)

	if (!userId) {
		throw new Response('Unauthorized', { status: 401 })
	}

	const formData = await request.formData()
	const intent = formData.get('intent')
	const ip = formData.get('ip')

	if (typeof ip !== 'string') {
		throw new Response('Invalid IP address', { status: 400 })
	}

	try {
		if (intent === 'blacklist') {
			const reason = formData.get('reason')
			if (typeof reason !== 'string') {
				throw new Response('Blacklist reason is required', { status: 400 })
			}
			await blacklistIp(ip, reason, userId)
			return { success: true, message: `IP ${ip} has been blacklisted` }
		} else if (intent === 'unblacklist') {
			await unblacklistIp(ip)
			return {
				success: true,
				message: `IP ${ip} has been removed from blacklist`,
			}
		}
	} catch (error) {
		console.error('Error processing IP action:', error)
		throw new Response('Failed to process request', { status: 500 })
	}

	throw new Response('Invalid action', { status: 400 })
}

export default function AdminIpAddressesPage() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()

	const formatDate = (date: string | Date | null) => {
		if (!date) return '-'
		return new Date(date).toLocaleString()
	}

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>IP Addresses</Trans>}
				description={
					<Trans>Monitor and manage IP addresses accessing your website</Trans>
				}
			/>

			{/* Stats */}
			<div className="grid grid-cols-1 gap-4 md:grid-cols-4">
				<div className="bg-card rounded-lg border p-4">
					<h3 className="text-muted-foreground text-sm font-medium">
						<Trans>Total IPs</Trans>
					</h3>
					<p className="text-2xl font-bold">{data.stats.totalIps}</p>
				</div>
				<div className="bg-card rounded-lg border p-4">
					<h3 className="text-muted-foreground text-sm font-medium">
						<Trans>Blacklisted IPs</Trans>
					</h3>
					<p className="flex items-center gap-2 text-2xl font-bold text-red-600">
						<Icon name="ban" className="h-5 w-5" aria-hidden="true" />
						<span>{data.stats.blacklistedIps}</span>
						<span className="sr-only">
							<Trans>blocked</Trans>
						</span>
					</p>
				</div>
				<div className="bg-card rounded-lg border p-4">
					<h3 className="text-muted-foreground text-sm font-medium">
						<Trans>Suspicious IPs</Trans>
					</h3>
					<p className="flex items-center gap-2 text-2xl font-bold text-yellow-600">
						<Icon
							name="alert-triangle"
							className="h-5 w-5"
							aria-hidden="true"
						/>
						<span>{data.stats.suspiciousIps}</span>
						<span className="sr-only">
							<Trans>suspicious</Trans>
						</span>
					</p>
				</div>
			</div>

			{/* IP Addresses Table */}
			<Frame className="w-full">
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>IP Address</Trans>
							</TableHead>
							<TableHead>
								<Trans>Location</Trans>
							</TableHead>
							<TableHead>
								<Trans>Status</Trans>
							</TableHead>
							<TableHead>
								<Trans>Requests</Trans>
							</TableHead>
							<TableHead>
								<Trans>Last Request</Trans>
							</TableHead>
							<TableHead>
								<Trans>Suspicious Score</Trans>
							</TableHead>
							<TableHead>
								<Trans>Users</Trans>
							</TableHead>
							<TableHead>
								<Trans>First Seen</Trans>
							</TableHead>
							<TableHead>
								<Trans>Actions</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.ipAddresses.map((ip) => {
							const moreCount = ip.ipAddressUsers.length - 3
							const ipAddress = ip.ip
							return (
								<TableRow key={ip.id}>
									<TableCell className="font-mono">
										<Link
											to={`/ip-addresses/${ip.ip}`}
											className="text-blue-600 hover:text-blue-800 hover:underline"
										>
											{ip.ip}
										</Link>
									</TableCell>
									<TableCell>
										{ip.country && ip.city ? (
											<span>
												{ip.city}, {ip.country}
											</span>
										) : ip.country ? (
											<span>{ip.country}</span>
										) : (
											<span className="text-muted-foreground">
												<Trans>Unknown</Trans>
											</span>
										)}
									</TableCell>
									<TableCell>
										{ip.isBlacklisted ? (
											<Badge variant="destructive">
												<Trans>Blacklisted</Trans>
											</Badge>
										) : ip.suspiciousScore > 0 ? (
											<Badge variant="secondary">
												<Trans>Suspicious</Trans>
											</Badge>
										) : (
											<Badge variant="outline">
												<Trans>Active</Trans>
											</Badge>
										)}
									</TableCell>
									<TableCell>{ip.requestCount}</TableCell>
									<TableCell>
										{ip.lastRequestAt ? (
											<span className="text-sm">
												{formatDate(ip.lastRequestAt)}
											</span>
										) : (
											<span className="text-muted-foreground">-</span>
										)}
									</TableCell>
									<TableCell>
										{ip.suspiciousScore > 0 ? (
											<Badge variant="destructive">{ip.suspiciousScore}</Badge>
										) : (
											<span className="text-muted-foreground">0</span>
										)}
									</TableCell>
									<TableCell>
										{ip.ipAddressUsers && ip.ipAddressUsers.length > 0 ? (
											<div className="space-y-1">
												{ip.ipAddressUsers.slice(0, 3).map((userConnection) => {
													const count = userConnection.requestCount

													return (
														<div
															key={userConnection.user.id}
															className="text-sm"
														>
															<span className="font-medium">
																{userConnection.user.name ||
																	userConnection.user.username}
															</span>
															<div className="text-muted-foreground text-xs">
																<Trans>{count} requests</Trans>
															</div>
														</div>
													)
												})}
												{ip.ipAddressUsers.length > 3 && (
													<div className="text-muted-foreground text-xs">
														<Trans>+{moreCount} more users</Trans>
													</div>
												)}
											</div>
										) : (
											<span className="text-muted-foreground text-sm">
												<Trans>No users</Trans>
											</span>
										)}
									</TableCell>
									<TableCell>
										<span className="text-sm">{formatDate(ip.createdAt)}</span>
									</TableCell>
									<TableCell>
										<div className="flex gap-2">
											{ip.isBlacklisted ? (
												<Form method="post">
													<input
														type="hidden"
														name="intent"
														value="unblacklist"
													/>
													<input type="hidden" name="ip" value={ip.ip} />
													<Button variant="outline" size="sm" type="submit">
														<Trans>Unblacklist</Trans>
													</Button>
												</Form>
											) : (
												<Dialog>
													<DialogTrigger
														render={
															<Button variant="destructive" size="sm">
																<Trans>Blacklist</Trans>
															</Button>
														}
													></DialogTrigger>
													<DialogContent>
														<DialogHeader>
															<DialogTitle>
																<Trans>Blacklist IP Address</Trans>
															</DialogTitle>
															<DialogDescription>
																<Trans>
																	Are you sure you want to blacklist {ipAddress}
																	? This will prevent all future requests from
																	this IP address.
																</Trans>
															</DialogDescription>
														</DialogHeader>
														<Form method="post">
															<div className="space-y-4">
																<div className="space-y-2">
																	<Label htmlFor="reason">
																		<Trans>Reason for blacklisting</Trans>
																	</Label>
																	<Textarea
																		id="reason"
																		name="reason"
																		placeholder={_(
																			msg`Enter reason for blacklisting this IP address...`,
																		)}
																		required
																	/>
																</div>
															</div>
															<input
																type="hidden"
																name="intent"
																value="blacklist"
															/>
															<input type="hidden" name="ip" value={ip.ip} />
															<DialogFooter className="mt-4">
																<Button type="submit" variant="destructive">
																	<Trans>Blacklist IP</Trans>
																</Button>
															</DialogFooter>
														</Form>
													</DialogContent>
												</Dialog>
											)}
										</div>
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</Frame>

			{data.ipAddresses.length === 0 && (
				<EmptyState
					title={_(msg`No IP addresses found`)}
					description={_(msg`Visitor IP addresses will appear here.`)}
					icons={['shield']}
				/>
			)}
		</div>
	)
}
