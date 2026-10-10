import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { auditService, AuditAction } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import {
	DataSubjectRequest,
	User,
	and,
	count,
	db,
	desc,
	eq,
	inArray,
	like,
	or,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { type FilterField } from '@repo/ui/filters'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useMemo } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
	useFetcher,
} from 'react-router'
import { TablePagination } from '#app/components/data-table/table-pagination.tsx'
import { UrlFilters } from '#app/components/data-table/url-filters.tsx'
import { EmptyState } from '#app/components/empty-state.tsx'

export async function loader({ request }: LoaderFunctionArgs) {
	const adminId = await requireUserWithRole(request, 'admin')

	const url = new URL(request.url)
	const page = Number(url.searchParams.get('page')) || 1
	const limit = 20
	const offset = (page - 1) * limit
	const typeFilter = url.searchParams.get('type') || undefined
	const statusFilter = url.searchParams.get('status') || undefined
	const search = url.searchParams.get('search') || undefined

	const matchingUserIds = search
		? await db
				.select({ id: User.id })
				.from(User)
				.where(
					or(
						like(User.email, `%${search}%`),
						like(User.username, `%${search}%`),
						like(User.name, `%${search}%`),
					),
				)
		: []
	const where = and(
		typeFilter ? eq(DataSubjectRequest.type, typeFilter) : undefined,
		statusFilter ? eq(DataSubjectRequest.status, statusFilter) : undefined,
		search
			? inArray(
					DataSubjectRequest.userId,
					matchingUserIds.map((row) => row.id),
				)
			: undefined,
	)

	const [requests, totalCount, statistics] = await Promise.all([
		db.query.DataSubjectRequest.findMany({
			where,
			with: { user: true },
			orderBy: desc(DataSubjectRequest.requestedAt),
			offset,
			limit,
		}),
		db
			.select({ count: count() })
			.from(DataSubjectRequest)
			.where(where)
			.then(([row]) => row?.count ?? 0),
		Promise.all([
			db
				.select({ count: count() })
				.from(DataSubjectRequest)
				.where(
					and(
						eq(DataSubjectRequest.type, 'export'),
						eq(DataSubjectRequest.status, 'completed'),
					),
				)
				.then(([row]) => row?.count ?? 0),
			db
				.select({ count: count() })
				.from(DataSubjectRequest)
				.where(
					and(
						eq(DataSubjectRequest.type, 'erasure'),
						eq(DataSubjectRequest.status, 'scheduled'),
					),
				)
				.then(([row]) => row?.count ?? 0),
			db
				.select({ count: count() })
				.from(DataSubjectRequest)
				.where(
					and(
						eq(DataSubjectRequest.type, 'erasure'),
						eq(DataSubjectRequest.status, 'completed'),
					),
				)
				.then(([row]) => row?.count ?? 0),
			db
				.select({ count: count() })
				.from(DataSubjectRequest)
				.where(eq(DataSubjectRequest.status, 'failed'))
				.then(([row]) => row?.count ?? 0),
		]),
	])

	const totalPages = Math.ceil(totalCount / limit)

	return {
		requests: requests.map((r) => ({
			...r,
			requestedAt: r.requestedAt.toISOString(),
			processedAt: r.processedAt?.toISOString() || null,
			completedAt: r.completedAt?.toISOString() || null,
			cancelledAt: r.cancelledAt?.toISOString() || null,
			scheduledFor: r.scheduledFor?.toISOString() || null,
			executedAt: r.executedAt?.toISOString() || null,
		})),
		pagination: {
			page,
			totalPages,
			totalCount,
		},
		statistics: {
			completedExports: statistics[0],
			pendingDeletions: statistics[1],
			completedDeletions: statistics[2],
			failedRequests: statistics[3],
		},
		filters: {
			type: typeFilter,
			status: statusFilter,
			search,
		},
		adminId,
	}
}

export async function action({ request }: ActionFunctionArgs) {
	const adminId = await requireUserWithRole(request, 'admin')
	const formData = await request.formData()
	const intent = formData.get('intent')
	const requestId = formData.get('requestId')

	if (typeof requestId !== 'string') {
		return Response.json({ error: 'Invalid request ID' }, { status: 400 })
	}

	const dsr = await db.query.DataSubjectRequest.findFirst({
		where: eq(DataSubjectRequest.id, requestId),
		with: { user: true },
	})

	if (!dsr) {
		return Response.json({ error: 'Request not found' }, { status: 404 })
	}

	switch (intent) {
		case 'cancel': {
			if (dsr.status !== 'scheduled') {
				return Response.json(
					{ error: 'Can only cancel scheduled requests' },
					{ status: 400 },
				)
			}

			await db
				.update(DataSubjectRequest)
				.set({
					status: 'cancelled',
					cancelledAt: new Date(),
				})
				.where(eq(DataSubjectRequest.id, requestId))

			await auditService.log({
				action: AuditAction.DATA_DELETION_CANCELLED,
				userId: adminId,
				targetUserId: dsr.userId!,
				details: `Admin cancelled deletion request for user ${dsr.user?.email}`,
				resourceType: 'data_subject_request',
				resourceId: requestId,
				request,
				metadata: { adminAction: true },
				severity: 'warning',
			})

			return Response.json({ success: true })
		}

		case 'expedite': {
			if (dsr.type !== 'erasure' || dsr.status !== 'scheduled') {
				return Response.json(
					{ error: 'Can only expedite scheduled erasure requests' },
					{ status: 400 },
				)
			}

			await db
				.update(DataSubjectRequest)
				.set({
					status: 'processing',
					processedAt: new Date(),
				})
				.where(eq(DataSubjectRequest.id, requestId))

			try {
				await db.delete(User).where(eq(User.id, dsr.userId!))

				await db
					.update(DataSubjectRequest)
					.set({
						status: 'completed',
						completedAt: new Date(),
						executedAt: new Date(),
					})
					.where(eq(DataSubjectRequest.id, requestId))

				await auditService.log({
					action: AuditAction.DATA_DELETION_COMPLETED,
					userId: adminId,
					details: `Admin expedited deletion for user ${dsr.user?.email}`,
					resourceType: 'data_subject_request',
					resourceId: requestId,
					request,
					metadata: {
						adminAction: true,
						expedited: true,
						targetUserId: dsr.userId,
					},
					severity: 'warning',
				})

				return Response.json({ success: true })
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : 'Unknown error'

				await db
					.update(DataSubjectRequest)
					.set({
						status: 'failed',
						failureReason: errorMessage,
					})
					.where(eq(DataSubjectRequest.id, requestId))

				await auditService.log({
					action: AuditAction.DATA_DELETION_FAILED,
					userId: adminId,
					details: `Admin expedited deletion failed: ${errorMessage}`,
					resourceType: 'data_subject_request',
					resourceId: requestId,
					request,
					metadata: { adminAction: true, error: errorMessage },
					severity: 'error',
				})

				return Response.json({ error: errorMessage }, { status: 500 })
			}
		}

		case 'export-for-user': {
			const userId = dsr.userId!

			const [newDsr] = await db
				.insert(DataSubjectRequest)
				.values({
					userId,
					type: 'export',
					status: 'completed',
					processedAt: new Date(),
					completedAt: new Date(),
					metadata: JSON.stringify({ adminInitiated: true, adminId }),
				})
				.returning({ id: DataSubjectRequest.id })
			if (!newDsr) throw new Error('Could not create export request')

			await auditService.log({
				action: AuditAction.DATA_EXPORT_COMPLETED,
				userId: adminId,
				targetUserId: userId,
				details: `Admin initiated data export for user ${dsr.user?.email}`,
				resourceType: 'data_subject_request',
				resourceId: newDsr.id,
				request,
				metadata: { adminAction: true },
				severity: 'info',
			})

			return Response.json({
				success: true,
				redirectUrl: `/gdpr-requests/export/${userId}`,
			})
		}

		default:
			return Response.json({ error: 'Invalid intent' }, { status: 400 })
	}
}

export default function GDPRRequestsPage() {
	const { _ } = useLingui()
	const { requests, pagination, statistics } = useLoaderData<typeof loader>()
	const fetcher = useFetcher()

	const filterFields = useMemo<FilterField[]>(
		() => [
			{
				id: 'search',
				label: _(msg`User`),
				type: 'text',
				defaultOperator: 'contains',
				operators: [{ value: 'contains', label: _(msg`contains`) }],
				placeholder: _(msg`Email, username, or name`),
				icon: <Icon name="user" className="size-3.5" />,
			},
			{
				id: 'type',
				label: _(msg`Request type`),
				type: 'select',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`is`) }],
				searchable: false,
				icon: <Icon name="file-text" className="size-3.5" />,
				options: [
					{ value: 'export', label: _(msg`Export (Article 20)`) },
					{ value: 'erasure', label: _(msg`Erasure (Article 17)`) },
				],
			},
			{
				id: 'status',
				label: _(msg`Status`),
				type: 'select',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`is`) }],
				searchable: false,
				icon: <Icon name="circle-check" className="size-3.5" />,
				options: [
					{ value: 'requested', label: _(msg`Requested`) },
					{ value: 'processing', label: _(msg`Processing`) },
					{ value: 'scheduled', label: _(msg`Scheduled`) },
					{ value: 'completed', label: _(msg`Completed`) },
					{ value: 'cancelled', label: _(msg`Cancelled`) },
					{ value: 'failed', label: _(msg`Failed`) },
				],
			},
		],
		[_],
	)

	const getStatusBadgeVariant = (status: string) => {
		switch (status) {
			case 'completed':
				return 'default'
			case 'scheduled':
				return 'secondary'
			case 'processing':
				return 'outline'
			case 'failed':
				return 'destructive'
			case 'cancelled':
				return 'outline'
			default:
				return 'secondary'
		}
	}

	const getTypeBadgeVariant = (type: string) => {
		return type === 'erasure' ? 'destructive' : 'default'
	}

	const formatDate = (dateStr: string | null) => {
		if (!dateStr) return '-'
		return new Intl.DateTimeFormat('en-US', {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(dateStr))
	}

	const showing = requests.length
	const totalRequests = pagination.totalCount.toLocaleString()

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>GDPR Data Requests</Trans>}
				description={
					<Trans>Manage data export and deletion requests for compliance</Trans>
				}
			/>

			<div className="grid gap-4 md:grid-cols-4">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Completed Exports</Trans>
						</CardTitle>
						<Icon name="download" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{statistics.completedExports}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Article 20 requests</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Pending Deletions</Trans>
						</CardTitle>
						<Icon name="clock" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{statistics.pendingDeletions}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>In grace period</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Completed Deletions</Trans>
						</CardTitle>
						<Icon name="trash-2" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{statistics.completedDeletions}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Article 17 fulfilled</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Failed Requests</Trans>
						</CardTitle>
						<Icon name="alert-triangle" className="text-destructive h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-destructive text-2xl font-bold">
							{statistics.failedRequests}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Requires attention</Trans>
						</p>
					</CardContent>
				</Card>
			</div>

			<div className="space-y-4">
				<UrlFilters fields={filterFields} />

				{requests.length > 0 ? (
					<Frame className="w-full">
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>User</Trans>
									</TableHead>
									<TableHead>
										<Trans>Type</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
									<TableHead className="hidden md:table-cell">
										<Trans>Requested</Trans>
									</TableHead>
									<TableHead className="hidden lg:table-cell">
										<Trans>Details</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{requests.map((req) => {
									const scheduledFor = req.scheduledFor
										? formatDate(req.scheduledFor)
										: null
									const completedAt = req.completedAt
										? formatDate(req.completedAt)
										: null
									return (
										<TableRow key={req.id}>
											<TableCell>
												<div className="text-sm font-medium">
													{req.user?.email || req.userId}
												</div>
												<div className="text-muted-foreground text-sm">
													{[
														req.user?.name,
														req.user?.username ? `@${req.user.username}` : null,
													]
														.filter(Boolean)
														.join(' · ')}
												</div>
											</TableCell>
											<TableCell>
												<Badge variant={getTypeBadgeVariant(req.type)}>
													{req.type === 'export' ? (
														<Trans>Export</Trans>
													) : (
														<Trans>Erasure</Trans>
													)}
												</Badge>
											</TableCell>
											<TableCell>
												<Badge variant={getStatusBadgeVariant(req.status)}>
													{req.status}
												</Badge>
											</TableCell>
											<TableCell className="text-muted-foreground hidden text-sm md:table-cell">
												{formatDate(req.requestedAt)}
											</TableCell>
											<TableCell className="hidden text-sm lg:table-cell">
												{scheduledFor && (
													<div className="text-destructive">
														{_(msg`Scheduled: ${scheduledFor}`)}
													</div>
												)}
												{completedAt && (
													<div className="text-green-600">
														{_(msg`Completed: ${completedAt}`)}
													</div>
												)}
												{req.failureReason && (
													<div className="text-destructive">
														{req.failureReason}
													</div>
												)}
											</TableCell>
											<TableCell className="text-end">
												{req.status === 'scheduled' && (
													<div className="flex justify-end gap-2">
														<fetcher.Form method="POST">
															<input
																type="hidden"
																name="requestId"
																value={req.id}
															/>
															<Button
																type="submit"
																name="intent"
																value="cancel"
																variant="outline"
																size="sm"
																disabled={fetcher.state !== 'idle'}
															>
																<Icon name="x" className="size-3" />
																<Trans>Cancel</Trans>
															</Button>
														</fetcher.Form>
														<fetcher.Form method="POST">
															<input
																type="hidden"
																name="requestId"
																value={req.id}
															/>
															<Button
																type="submit"
																name="intent"
																value="expedite"
																variant="destructive"
																size="sm"
																disabled={fetcher.state !== 'idle'}
															>
																<Icon name="play" className="size-3" />
																<Trans>Expedite Now</Trans>
															</Button>
														</fetcher.Form>
													</div>
												)}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
							<TableFooter>
								<TableRow>
									<TableCell colSpan={6}>
										<Trans>
											Showing {showing} of {totalRequests} requests
										</Trans>
									</TableCell>
								</TableRow>
							</TableFooter>
						</Table>
					</Frame>
				) : (
					<EmptyState
						title={_(msg`No GDPR requests found`)}
						description={_(msg`Try different filters or clear them.`)}
						icons={['file-text']}
					/>
				)}

				<TablePagination
					showPageSize={false}
					pagination={{
						page: pagination.page,
						pageSize: 20,
						totalCount: pagination.totalCount,
						totalPages: pagination.totalPages,
					}}
				/>
			</div>
		</div>
	)
}
