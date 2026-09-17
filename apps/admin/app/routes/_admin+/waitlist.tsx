import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import {
	User as UserTable,
	WaitlistEntry as WaitlistEntryTable,
	and,
	count,
	db,
	desc,
	eq,
	inArray,
	like,
	or,
} from '@repo/database'
import {
	type WaitlistEntry as WaitlistEntryModel,
	type User as UserModel,
	type UserImage,
} from '@repo/database/types'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Img } from 'openimg/react'
import { useCallback, useEffect, useState } from 'react'
import {
	useLoaderData,
	Form,
	useNavigation,
	useSearchParams,
} from 'react-router'
import { getLaunchStatus } from '#app/utils/env.server.ts'
import {
	addWaitlistPoints,
	grantEarlyAccess,
	revokeEarlyAccess,
} from '#app/utils/waitlist.server.ts'
import { type Route } from './+types/waitlist.ts'

const MAX_ADMIN_POINTS_ADJUSTMENT = 1000

export async function loader({ request }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')

	const launchStatus = getLaunchStatus()

	const url = new URL(request.url)
	const searchQuery = url.searchParams.get('search') || ''
	const filterStatus = url.searchParams.get('status') || 'all' // 'all', 'granted', 'pending'
	const page = parseInt(url.searchParams.get('page') || '1', 10)
	const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10)
	const sortBy = url.searchParams.get('sortBy') || 'rank' // 'rank', 'date', 'points'

	const matchingUserIds = searchQuery
		? await db
				.select({ id: UserTable.id })
				.from(UserTable)
				.where(
					or(
						like(UserTable.name, `%${searchQuery}%`),
						like(UserTable.email, `%${searchQuery}%`),
						like(UserTable.username, `%${searchQuery}%`),
					),
				)
		: []
	const where = and(
		searchQuery
			? inArray(
					WaitlistEntryTable.userId,
					matchingUserIds.map((row) => row.id),
				)
			: undefined,
		filterStatus === 'granted'
			? eq(WaitlistEntryTable.hasEarlyAccess, true)
			: filterStatus === 'pending'
				? eq(WaitlistEntryTable.hasEarlyAccess, false)
				: undefined,
	)

	// Get all entries for rank calculation (we need to calculate ranks across ALL entries, not just the current page)
	// Then we'll slice for pagination
	const [allEntries, totalCount] = await Promise.all([
		db.query.WaitlistEntry.findMany({
			where,
			with: {
				user: { with: { image: true } },
				referrals: { columns: { id: true } },
			},
			orderBy:
				sortBy === 'date'
					? desc(WaitlistEntryTable.createdAt)
					: desc(WaitlistEntryTable.points),
		}),
		db
			.select({ count: count() })
			.from(WaitlistEntryTable)
			.where(where)
			.then(([row]) => row?.count ?? 0),
	])

	// Calculate ranks for ALL entries in memory (more efficient than N queries)
	// Sort by points DESC, then createdAt ASC for ranking
	const sortedEntries = [...allEntries].sort((a, b) => {
		if (b.points !== a.points) {
			return b.points - a.points
		}
		return a.createdAt.getTime() - b.createdAt.getTime()
	})

	// Assign ranks
	const entriesWithRanks = sortedEntries.map((entry, index) => ({
		...entry,
		rank: index + 1,
		referralCount: entry.referrals.length,
	}))

	// Apply pagination to the ranked entries
	const paginatedEntries = entriesWithRanks.slice(
		(page - 1) * pageSize,
		page * pageSize,
	)

	const totalPages = Math.ceil(totalCount / pageSize)

	return Response.json({
		entries: paginatedEntries,
		pagination: {
			page,
			pageSize,
			totalCount,
			totalPages,
		},
		filters: {
			search: searchQuery,
			status: filterStatus,
			sortBy,
		},
		launchStatus,
	})
}

export async function action({ request }: Route.ActionArgs) {
	const adminUserId = await requireUserWithRole(request, 'admin')

	const formData = await request.formData()
	const intent = formData.get('intent')
	const userId = formData.get('userId') as string

	if (!userId) {
		return Response.json({ error: 'User ID is required' }, { status: 400 })
	}

	try {
		if (intent === 'grant-access') {
			await grantEarlyAccess(userId, adminUserId)
			return Response.json({ success: true, message: 'Access granted' })
		} else if (intent === 'revoke-access') {
			await revokeEarlyAccess(userId)
			return Response.json({ success: true, message: 'Access revoked' })
		} else if (intent === 'add-points') {
			const points = Number(formData.get('points'))
			if (
				!Number.isSafeInteger(points) ||
				points < 1 ||
				points > MAX_ADMIN_POINTS_ADJUSTMENT
			) {
				return Response.json(
					{
						error: `Points must be a whole number between 1 and ${MAX_ADMIN_POINTS_ADJUSTMENT}`,
					},
					{ status: 400 },
				)
			}
			await addWaitlistPoints(userId, points)
			return Response.json({ success: true, message: 'Points added' })
		}

		return Response.json({ error: 'Invalid intent' }, { status: 400 })
	} catch (error) {
		console.error('Waitlist action error:', error)
		return Response.json(
			{ error: 'Failed to process request' },
			{ status: 500 },
		)
	}
}

type LoaderData = {
	entries: (WaitlistEntryModel & {
		user: Pick<UserModel, 'id' | 'name' | 'email' | 'username'> & {
			image: Pick<UserImage, 'id' | 'altText' | 'objectKey'> | null
		}
		referrals: { id: string }[]
		rank: number
		referralCount: number
	})[]
	pagination: {
		page: number
		pageSize: number
		totalCount: number
		totalPages: number
	}
	filters: {
		search: string
		status: string
		sortBy: string
	}
	launchStatus: 'CLOSED_BETA' | 'PUBLIC_BETA' | 'LAUNCHED'
}

export default function AdminWaitlistPage() {
	const { _ } = useLingui()
	const data = useLoaderData() as LoaderData
	const navigation = useNavigation()
	const [searchParams, setSearchParams] = useSearchParams()
	const [searchValue, setSearchValue] = useState(data.filters.search)

	const isProcessing = navigation.state === 'submitting'

	const handleFilterChange = useCallback(
		(key: string, value: string) => {
			const newParams = new URLSearchParams(searchParams)
			if (value) {
				newParams.set(key, value)
			} else {
				newParams.delete(key)
			}
			newParams.set('page', '1') // Reset to first page when filtering
			setSearchParams(newParams)
		},
		[searchParams, setSearchParams],
	)

	// Debounce search input
	useEffect(() => {
		const timer = setTimeout(() => {
			if (searchValue !== data.filters.search) {
				handleFilterChange('search', searchValue)
			}
		}, 300)
		return () => clearTimeout(timer)
	}, [searchValue, data.filters.search, handleFilterChange])

	const handlePageChange = (newPage: number) => {
		const newParams = new URLSearchParams(searchParams)
		newParams.set('page', String(newPage))
		setSearchParams(newParams)
	}

	const launchStatus = data.launchStatus
	const totalCount = data.pagination.totalCount
	const startEntry = (data.pagination.page - 1) * data.pagination.pageSize + 1
	const endEntry = Math.min(
		data.pagination.page * data.pagination.pageSize,
		data.pagination.totalCount,
	)

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-3xl font-bold tracking-tight">
					<Trans>Waitlist Management</Trans>
				</h1>
				<p className="text-muted-foreground">
					<Trans>Manage waitlist users and grant early access</Trans>
				</p>
			</div>

			{launchStatus !== 'CLOSED_BETA' && (
				<Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10">
					<CardContent>
						<div className="flex items-start gap-2">
							<Icon
								name="help-circle"
								className="h-5 w-5 text-yellow-600 dark:text-yellow-400"
							/>
							<div className="text-sm text-yellow-800 dark:text-yellow-200">
								<Trans>
									Launch status is currently <strong>{launchStatus}</strong>.
									The waitlist is only active when LAUNCH_STATUS is set to
									CLOSED_BETA.
								</Trans>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Filters</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap gap-4">
						<div className="min-w-[200px] flex-1">
							<Input
								type="search"
								placeholder={_(t`Search by name, email, or username...`)}
								value={searchValue}
								onChange={(e) => setSearchValue(e.target.value)}
							/>
						</div>

						<select
							className="rounded-md border px-3 py-2"
							value={data.filters.status}
							onChange={(e) => handleFilterChange('status', e.target.value)}
						>
							<option value="all">{_(t`All Users`)}</option>
							<option value="pending">{_(t`Pending Access`)}</option>
							<option value="granted">{_(t`Access Granted`)}</option>
						</select>

						<select
							className="rounded-md border px-3 py-2"
							value={data.filters.sortBy}
							onChange={(e) => handleFilterChange('sortBy', e.target.value)}
						>
							<option value="rank">{_(t`Sort by Rank`)}</option>
							<option value="points">{_(t`Sort by Points`)}</option>
							<option value="date">{_(t`Sort by Date`)}</option>
						</select>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Waitlist Entries ({totalCount})</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Rank</Trans>
								</TableHead>
								<TableHead>
									<Trans>User</Trans>
								</TableHead>
								<TableHead>
									<Trans>Email</Trans>
								</TableHead>
								<TableHead>
									<Trans>Points</Trans>
								</TableHead>
								<TableHead>
									<Trans>Referrals</Trans>
								</TableHead>
								<TableHead>
									<Trans>Discord</Trans>
								</TableHead>
								<TableHead>
									<Trans>Joined</Trans>
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
							{data.entries.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={9}
										className="text-muted-foreground text-center"
									>
										<Trans>No waitlist entries found</Trans>
									</TableCell>
								</TableRow>
							) : (
								data.entries.map((entry) => (
									<TableRow key={entry.id}>
										<TableCell className="font-medium">#{entry.rank}</TableCell>
										<TableCell>
											<div className="flex items-center gap-2">
												{entry.user.image && (
													<Img
														className="h-8 w-8 rounded-full object-cover"
														src={entry.user.image.objectKey}
														alt={
															entry.user.image.altText ??
															entry.user.name ??
															'User'
														}
														width={32}
														height={32}
													/>
												)}
												<div>
													<div className="font-medium">{entry.user.name}</div>
													<div className="text-muted-foreground text-sm">
														@{entry.user.username}
													</div>
												</div>
											</div>
										</TableCell>
										<TableCell>{entry.user.email}</TableCell>
										<TableCell>
											<Badge variant="secondary">{entry.points} pts</Badge>
										</TableCell>
										<TableCell>{entry.referralCount}</TableCell>
										<TableCell>
											{entry.hasJoinedDiscord ? (
												<Icon name="check" className="h-4 w-4 text-green-600" />
											) : (
												<Icon name="x" className="h-4 w-4 text-gray-400" />
											)}
										</TableCell>
										<TableCell>
											{new Date(entry.createdAt).toLocaleDateString()}
										</TableCell>
										<TableCell>
											{entry.hasEarlyAccess ? (
												<Badge variant="default">
													<Trans>Access Granted</Trans>
												</Badge>
											) : (
												<Badge variant="outline">
													<Trans>Pending</Trans>
												</Badge>
											)}
										</TableCell>
										<TableCell>
											<div className="flex flex-wrap gap-2">
												<Dialog>
													<DialogTrigger
														render={
															<Button
																variant="outline"
																size="sm"
																disabled={isProcessing}
															>
																<Icon name="plus" className="mr-1 h-3 w-3" />
																<Trans>Add points</Trans>
															</Button>
														}
													/>
													<DialogContent>
														<DialogHeader>
															<DialogTitle>
																<Trans>Add waitlist points</Trans>
															</DialogTitle>
															<DialogDescription>
																<Trans>
																	Add points to{' '}
																	{entry.user.name ?? entry.user.username}'s
																	current total of {entry.points}.
																</Trans>
															</DialogDescription>
														</DialogHeader>
														<Form method="post" className="space-y-4">
															<input
																type="hidden"
																name="intent"
																value="add-points"
															/>
															<input
																type="hidden"
																name="userId"
																value={entry.userId}
															/>
															<div className="space-y-2">
																<Label htmlFor={`points-${entry.id}`}>
																	<Trans>Points to add</Trans>
																</Label>
																<Input
																	id={`points-${entry.id}`}
																	name="points"
																	type="number"
																	min={1}
																	max={MAX_ADMIN_POINTS_ADJUSTMENT}
																	defaultValue={5}
																	required
																/>
																<p className="text-muted-foreground text-xs">
																	<Trans>
																		Enter a whole number from 1 to{' '}
																		{MAX_ADMIN_POINTS_ADJUSTMENT}.
																	</Trans>
																</p>
															</div>
															<DialogFooter>
																<DialogClose
																	render={<Button variant="outline" />}
																>
																	<Trans>Cancel</Trans>
																</DialogClose>
																<Button type="submit" disabled={isProcessing}>
																	<Icon name="plus" className="mr-1 h-4 w-4" />
																	<Trans>Add points</Trans>
																</Button>
															</DialogFooter>
														</Form>
													</DialogContent>
												</Dialog>
												<Form method="post">
													<input
														type="hidden"
														name="userId"
														value={entry.userId}
													/>
													{entry.hasEarlyAccess ? (
														<Button
															type="submit"
															name="intent"
															value="revoke-access"
															variant="outline"
															size="sm"
															disabled={isProcessing}
														>
															<Icon name="x" className="mr-1 h-3 w-3" />
															<Trans>Revoke</Trans>
														</Button>
													) : (
														<Button
															type="submit"
															name="intent"
															value="grant-access"
															variant="default"
															size="sm"
															disabled={isProcessing}
														>
															<Icon name="check" className="mr-1 h-3 w-3" />
															<Trans>Grant Access</Trans>
														</Button>
													)}
												</Form>
											</div>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>

					{/* Pagination */}
					{data.pagination.totalPages > 1 && (
						<div className="mt-4 flex items-center justify-between">
							<div className="text-muted-foreground text-sm">
								<Trans>
									Showing {startEntry} to {endEntry} of {totalCount} entries
								</Trans>
							</div>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={data.pagination.page === 1}
									onClick={() => handlePageChange(data.pagination.page - 1)}
								>
									<Trans>Previous</Trans>
								</Button>
								<div className="flex items-center gap-1">
									{Array.from(
										{ length: data.pagination.totalPages },
										(_, i) => i + 1,
									)
										.filter((page) => {
											const currentPage = data.pagination.page
											return (
												page === 1 ||
												page === data.pagination.totalPages ||
												(page >= currentPage - 1 && page <= currentPage + 1)
											)
										})
										.map((page, index, array) => {
											const prevPage = array[index - 1]
											if (index > 0 && prevPage && page - prevPage > 1) {
												return (
													<span key={`ellipsis-${page}`} className="px-2">
														...
													</span>
												)
											}
											return (
												<Button
													key={page}
													variant={
														page === data.pagination.page
															? 'default'
															: 'outline'
													}
													size="sm"
													onClick={() => handlePageChange(page)}
												>
													{page}
												</Button>
											)
										})}
								</div>
								<Button
									variant="outline"
									size="sm"
									disabled={data.pagination.page === data.pagination.totalPages}
									onClick={() => handlePageChange(data.pagination.page + 1)}
								>
									<Trans>Next</Trans>
								</Button>
							</div>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
