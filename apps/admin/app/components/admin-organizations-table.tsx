import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { type FilterField } from '@repo/ui/filters'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	useReactTable,
	type VisibilityState,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { TablePagination } from '#app/components/data-table/table-pagination.tsx'
import { UrlFilters } from '#app/components/data-table/url-filters.tsx'
import { EmptyState } from '#app/components/empty-state.tsx'

export interface AdminOrganization {
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
	memberCount: number
	totalMembers: number
	noteCount: number
	activeIntegrations: number
	totalIntegrations: number
	image?: {
		id: string
		altText: string | null
	} | null
}

export interface Pagination {
	page: number
	pageSize: number
	totalCount: number
	totalPages: number
}

export interface Filters {
	search: string
	subscriptionStatus: string
	plan: string
}

interface AdminOrganizationsTableProps {
	organizations: AdminOrganization[]
	subscriptionStatuses: string[]
	planNames: string[]
	pagination: Pagination
	filters: Filters
}

const SubscriptionStatusBadge = ({ status }: { status: string | null }) => {
	if (!status) {
		return (
			<Badge variant="secondary">
				<Trans>No Subscription</Trans>
			</Badge>
		)
	}

	switch (status.toLowerCase()) {
		case 'active':
			return (
				<Badge variant="default">
					<Trans>Active</Trans>
				</Badge>
			)
		case 'canceled':
		case 'cancelled':
			return (
				<Badge variant="destructive">
					<Trans>Canceled</Trans>
				</Badge>
			)
		case 'past_due':
			return (
				<Badge variant="destructive">
					<Trans>Past Due</Trans>
				</Badge>
			)
		case 'unpaid':
			return (
				<Badge variant="destructive">
					<Trans>Unpaid</Trans>
				</Badge>
			)
		case 'trialing':
			return (
				<Badge variant="secondary">
					<Trans>Trial</Trans>
				</Badge>
			)
		case 'incomplete':
			return (
				<Badge variant="outline">
					<Trans>Incomplete</Trans>
				</Badge>
			)
		default:
			return <Badge variant="outline">{status}</Badge>
	}
}

const getColumns = (
	_: ReturnType<typeof useLingui>['_'],
): ColumnDef<AdminOrganization>[] => [
	{
		accessorKey: 'organization',
		header: _(msg`Organization`),
		cell: ({ row }) => {
			const org = row.original
			return (
				<div className="flex items-center gap-3">
					<Avatar className="h-8 w-8">
						<AvatarImage
							src={
								org.image?.id
									? `/resources/organization-images/${org.image.id}`
									: undefined
							}
							alt={org.image?.altText ?? org.name}
						/>
						<AvatarFallback>
							<Icon name="blocks" className="h-4 w-4" />
						</AvatarFallback>
					</Avatar>
					<div className="flex flex-col">
						<span className="font-medium">{org.name}</span>
						<span className="text-muted-foreground text-sm">{org.slug}</span>
					</div>
				</div>
			)
		},
		enableHiding: false,
	},
	{
		accessorKey: 'description',
		header: _(msg`Description`),
		cell: ({ row }) => {
			const description = row.original.description
			if (!description) {
				return (
					<span className="text-muted-foreground">
						<Trans>No description</Trans>
					</span>
				)
			}
			return (
				<span className="max-w-xs truncate text-sm" title={description}>
					{description}
				</span>
			)
		},
	},
	{
		accessorKey: 'members',
		header: _(msg`Members`),
		cell: ({ row }) => {
			const org = row.original
			return (
				<div className="flex items-center gap-2">
					<Icon name="user-plus" className="text-muted-foreground h-4 w-4" />
					<span className="text-sm">
						{org.memberCount}
						{org.totalMembers !== org.memberCount && (
							<span className="text-muted-foreground">/{org.totalMembers}</span>
						)}
					</span>
				</div>
			)
		},
	},
	{
		accessorKey: 'notes',
		header: _(msg`Notes`),
		cell: ({ row }) => {
			const noteCount = row.original.noteCount
			return (
				<div className="flex items-center gap-2">
					<Icon name="file-text" className="text-muted-foreground h-4 w-4" />
					<span className="text-sm">{noteCount}</span>
				</div>
			)
		},
	},
	{
		accessorKey: 'integrations',
		header: _(msg`Integrations`),
		cell: ({ row }) => {
			const org = row.original
			return (
				<div className="flex items-center gap-2">
					<Icon name="link-2" className="text-muted-foreground h-4 w-4" />
					<span className="text-sm">
						{org.activeIntegrations}
						{org.totalIntegrations !== org.activeIntegrations && (
							<span className="text-muted-foreground">
								/{org.totalIntegrations}
							</span>
						)}
					</span>
				</div>
			)
		},
	},
	{
		accessorKey: 'subscription',
		header: _(msg`Subscription`),
		cell: ({ row }) => {
			const org = row.original
			return (
				<div className="flex flex-col gap-1">
					<SubscriptionStatusBadge status={org.subscriptionStatus} />
					{org.planName && (
						<span className="text-muted-foreground text-xs">
							{org.planName}
						</span>
					)}
				</div>
			)
		},
	},
	{
		accessorKey: 'size',
		header: _(msg`Size`),
		cell: ({ row }) => {
			const size = row.original.size
			if (!size) {
				return <span className="text-muted-foreground">-</span>
			}
			return <Badge variant="outline">{size}</Badge>
		},
	},
	{
		accessorKey: 'status',
		header: _(msg`Status`),
		cell: ({ row }) => {
			const isActive = row.original.active
			return (
				<Badge variant={isActive ? 'default' : 'secondary'}>
					{isActive ? <Trans>Active</Trans> : <Trans>Inactive</Trans>}
				</Badge>
			)
		},
	},
	{
		accessorKey: 'createdAt',
		header: _(msg`Created`),
		cell: ({ row }) => (
			<span className="text-sm">
				{new Date(row.original.createdAt).toLocaleDateString()}
			</span>
		),
	},
]

export function AdminOrganizationsTable({
	organizations,
	subscriptionStatuses,
	planNames,
	pagination,
	filters,
}: AdminOrganizationsTableProps) {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
	const columns = getColumns(_)

	const filterFields = useMemo<FilterField[]>(
		() => [
			{
				id: 'search',
				label: _(msg`Search`),
				type: 'text',
				defaultOperator: 'contains',
				operators: [{ value: 'contains', label: _(msg`contains`) }],
				placeholder: _(msg`Name, slug or description`),
				icon: <Icon name="search" className="size-3.5" />,
			},
			{
				id: 'subscriptionStatus',
				label: _(msg`Subscription`),
				type: 'select',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`is`) }],
				icon: <Icon name="credit-card" className="size-3.5" />,
				options: subscriptionStatuses.map((status) => ({
					value: status,
					label: status,
				})),
			},
			{
				id: 'plan',
				label: _(msg`Plan`),
				type: 'select',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`is`) }],
				icon: <Icon name="crown" className="size-3.5" />,
				options: planNames.map((plan) => ({ value: plan, label: plan })),
			},
		],
		[_, subscriptionStatuses, planNames],
	)

	const table = useReactTable({
		data: organizations,
		columns,
		state: { columnVisibility },
		onColumnVisibilityChange: setColumnVisibility,
		getCoreRowModel: getCoreRowModel(),
		manualPagination: true,
		pageCount: pagination.totalPages,
	})

	const hasActiveFilters = Boolean(
		filters.search || filters.subscriptionStatus || filters.plan,
	)
	const rows = table.getRowModel().rows
	const totalCount = pagination.totalCount

	return (
		<div className="space-y-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<UrlFilters fields={filterFields} className="flex-1" />
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button variant="outline" size="sm">
								<Trans>Columns</Trans>
								<Icon name="chevron-down" className="size-4" />
							</Button>
						}
					/>
					<DropdownMenuContent align="end" className="w-48">
						{table
							.getAllColumns()
							.filter(
								(column) =>
									typeof column.accessorFn !== 'undefined' &&
									column.getCanHide(),
							)
							.map((column) => (
								<DropdownMenuCheckboxItem
									key={column.id}
									className="capitalize"
									checked={column.getIsVisible()}
									onCheckedChange={(value) => column.toggleVisibility(!!value)}
								>
									{column.id}
								</DropdownMenuCheckboxItem>
							))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{rows.length === 0 ? (
				<EmptyState
					title={
						hasActiveFilters
							? _(msg`No organizations match`)
							: _(msg`No organizations yet`)
					}
					description={
						hasActiveFilters
							? _(msg`Try different filters or clear them.`)
							: _(msg`Organizations will appear here once they are created.`)
					}
					icons={['building']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							{table.getHeaderGroups().map((headerGroup) => (
								<TableRow key={headerGroup.id}>
									{headerGroup.headers.map((header) => (
										<TableHead key={header.id}>
											{header.isPlaceholder
												? null
												: flexRender(
														header.column.columnDef.header,
														header.getContext(),
													)}
										</TableHead>
									))}
								</TableRow>
							))}
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TableRow
									key={row.id}
									className="cursor-pointer"
									onClick={() =>
										void navigate(`/organizations/${row.original.id}`)
									}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											void navigate(`/organizations/${row.original.id}`)
										}
									}}
									role="button"
									tabIndex={0}
								>
									{row.getVisibleCells().map((cell) => (
										<TableCell key={cell.id}>
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext(),
											)}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
						<TableFooter>
							<TableRow>
								<TableCell colSpan={table.getVisibleLeafColumns().length}>
									{totalCount === 1 ? (
										<Trans>1 organization</Trans>
									) : (
										<Trans>{totalCount} organizations</Trans>
									)}
								</TableCell>
							</TableRow>
						</TableFooter>
					</Table>
				</Frame>
			)}

			<TablePagination pagination={pagination} />
		</div>
	)
}
