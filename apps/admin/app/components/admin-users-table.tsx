import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getUserImgSrc } from '@repo/common'
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
import { UrlFilters } from '#app/components/data-table/url-filters.tsx'
import { TablePagination } from '#app/components/data-table/table-pagination.tsx'
import { EmptyState } from '#app/components/empty-state.tsx'

export interface AdminUser {
	id: string
	name: string | null
	email: string
	username: string
	createdAt: string
	updatedAt: string
	organizationCount: number
	lastLoginAt: string | null
	isBanned: boolean
	banReason: string | null
	banExpiresAt: string | null
	bannedAt: string | null
	image?: {
		id: string
		altText: string | null
	} | null
	organizations: Array<{
		organization: {
			id: string
			name: string
		}
	}>
}

export interface Organization {
	id: string
	name: string
}

export interface Pagination {
	page: number
	pageSize: number
	totalCount: number
	totalPages: number
}

export interface Filters {
	search: string
	organization: string
}

interface AdminUsersTableProps {
	users: AdminUser[]
	organizations: Organization[]
	pagination: Pagination
	filters: Filters
}

const getColumns = (
	_: ReturnType<typeof useLingui>['_'],
): ColumnDef<AdminUser>[] => [
	{
		accessorKey: 'user',
		header: _(msg`User`),
		cell: ({ row }) => {
			const user = row.original
			return (
				<div className="flex items-center gap-3">
					<Avatar className="h-8 w-8">
						<AvatarImage
							src={getUserImgSrc(user.image?.id)}
							alt={user.image?.altText ?? user.name ?? user.username}
						/>
						<AvatarFallback>
							{(user.name ?? user.username).slice(0, 2).toUpperCase()}
						</AvatarFallback>
					</Avatar>
					<div className="flex flex-col">
						<span className="font-medium">{user.name || user.username}</span>
						<span className="text-muted-foreground text-sm">{user.email}</span>
					</div>
				</div>
			)
		},
		enableHiding: false,
	},
	{
		accessorKey: 'username',
		header: _(msg`Username`),
		cell: ({ row }) => (
			<span className="font-mono text-sm">{row.original.username}</span>
		),
	},
	{
		accessorKey: 'organizations',
		header: _(msg`Organizations`),
		cell: ({ row }) => {
			const orgs = row.original.organizations
			if (!orgs || orgs.length === 0) {
				return (
					<span className="text-muted-foreground">
						<Trans>None</Trans>
					</span>
				)
			}

			// Get the first valid organization
			const firstOrg = orgs.find((org) => org?.organization?.name)
			if (!firstOrg) {
				return (
					<span className="text-muted-foreground">
						<Trans>None</Trans>
					</span>
				)
			}

			if (orgs.length === 1) {
				return <Badge variant="secondary">{firstOrg.organization.name}</Badge>
			}

			return (
				<div className="flex items-center gap-1">
					<Badge variant="secondary">{firstOrg.organization.name}</Badge>
					{orgs.length > 1 && (
						<Badge variant="outline">+{orgs.length - 1}</Badge>
					)}
				</div>
			)
		},
	},
	{
		accessorKey: 'status',
		header: _(msg`Status`),
		cell: ({ row }) => {
			const user = row.original
			if (user.isBanned) {
				const isBanExpired =
					user.banExpiresAt && new Date(user.banExpiresAt) <= new Date()
				return (
					<Badge variant="destructive" className="gap-1">
						<Icon name="ban" className="h-3 w-3" />
						{isBanExpired ? <Trans>Ban Expired</Trans> : <Trans>Banned</Trans>}
					</Badge>
				)
			}
			return (
				<Badge variant="default">
					<Trans>Active</Trans>
				</Badge>
			)
		},
	},
	{
		accessorKey: 'lastLoginAt',
		header: _(msg`Last Login`),
		cell: ({ row }) => {
			const lastLogin = row.original.lastLoginAt
			if (!lastLogin) {
				return (
					<span className="text-muted-foreground">
						<Trans>Never</Trans>
					</span>
				)
			}
			return (
				<span className="text-sm">
					{new Date(lastLogin).toLocaleDateString()}
				</span>
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

export function AdminUsersTable({
	users,
	organizations,
	pagination,
	filters,
}: AdminUsersTableProps) {
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
				placeholder: _(msg`Name, email or username`),
				icon: <Icon name="search" className="size-3.5" />,
			},
			{
				id: 'organization',
				label: _(msg`Organization`),
				type: 'select',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`is`) }],
				icon: <Icon name="building" className="size-3.5" />,
				options: organizations.map((org) => ({
					value: org.name,
					label: org.name,
				})),
			},
		],
		[_, organizations],
	)

	const table = useReactTable({
		data: users,
		columns,
		state: { columnVisibility },
		onColumnVisibilityChange: setColumnVisibility,
		getCoreRowModel: getCoreRowModel(),
		manualPagination: true,
		pageCount: pagination.totalPages,
	})

	const hasActiveFilters = Boolean(filters.search || filters.organization)
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
						hasActiveFilters ? _(msg`No users match`) : _(msg`No users yet`)
					}
					description={
						hasActiveFilters
							? _(msg`Try different filters or clear them.`)
							: _(msg`Users will appear here once they sign up.`)
					}
					icons={['users']}
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
									onClick={() => void navigate(`/users/${row.original.id}`)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											void navigate(`/users/${row.original.id}`)
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
										<Trans>1 user</Trans>
									) : (
										<Trans>{totalCount} users</Trans>
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
