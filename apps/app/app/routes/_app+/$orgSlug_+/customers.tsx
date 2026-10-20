import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { cn } from '@repo/ui'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import {
	BadgesOrStack,
	createFilterQuery,
	Filters,
	flattenFilterConditions,
	type FilterCondition,
	type FilterField,
	type FilterQuery,
} from '@repo/ui/filters'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspacePage, WorkspaceToolbar } from '@repo/ui/workspace'
import { formatDistanceToNow } from 'date-fns'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	classifyEraseError,
	eraseConfirmationTargets,
	type EraseErrorKind,
	matchesEraseConfirmation,
} from '#app/utils/customers/erase-dialog.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

interface CustomerListItem {
	id: string
	name: string
	email: string | null
	phone: string | null
	phoneVerified: boolean | null
	createdAt: string
}

const ERASE_ERROR_MESSAGES = {
	permission: msg`You are not allowed to erase customer data.`,
	recording: msg`A call recording could not be deleted, so nothing was erased. Try again in a moment.`,
	unavailable: msg`The customer data service is unavailable. Nothing was erased; try again later.`,
	network: msg`Could not reach the customer data service. Check your connection and try again.`,
	generic: msg`The customer could not be erased. Nothing was changed.`,
} as const

const VERIFICATION_TONES = {
	verified: {
		dot: 'bg-emerald-500',
		badge:
			'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/15 dark:text-emerald-300',
	},
	unverified: {
		dot: 'bg-muted-foreground/64',
		badge:
			'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground',
	},
} as const

function Swatch({ className }: { className: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn('size-2.5 shrink-0 rounded-full', className)}
		/>
	)
}

const CUSTOMER_FILTER_FIELDS: FilterField[] = [
	{
		id: 'status',
		label: 'Status',
		type: 'select',
		defaultOperator: 'is_any_of',
		searchable: false,
		icon: <Icon name="circle-check" className="size-3.5" />,
		options: [
			{
				value: 'verified',
				label: 'Verified',
				icon: <Swatch className={VERIFICATION_TONES.verified.dot} />,
			},
			{
				value: 'unverified',
				label: 'Unverified',
				icon: <Swatch className={VERIFICATION_TONES.unverified.dot} />,
			},
		],
		renderValue: ({ options }) => (
			<BadgesOrStack
				options={options}
				fallback="any status"
				// eslint-disable-next-line shadcn/require-static-classes -- classes come from the static tone map above
				badgeClassName={(value) =>
					VERIFICATION_TONES[value as keyof typeof VERIFICATION_TONES]?.badge
				}
				// eslint-disable-next-line shadcn/require-static-classes -- classes come from the static tone map above
				dotClassName={(value) =>
					VERIFICATION_TONES[value as keyof typeof VERIFICATION_TONES]?.dot
				}
			/>
		),
	},
	{
		id: 'name',
		label: 'Name',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter a name',
		icon: <Icon name="user" className="size-3.5" />,
	},
	{
		id: 'email',
		label: 'Email',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter an email',
		icon: <Icon name="mail" className="size-3.5" />,
	},
	{
		id: 'phone',
		label: 'Phone',
		type: 'text',
		defaultOperator: 'contains',
		placeholder: 'Enter a phone number',
		icon: <Icon name="smartphone" className="size-3.5" />,
	},
]

function getCustomerFieldValue(
	customer: CustomerListItem,
	field: string,
): string {
	switch (field) {
		case 'status':
			return customer.phoneVerified ? 'verified' : 'unverified'
		case 'name':
			return customer.name
		case 'email':
			return customer.email ?? ''
		case 'phone':
			return customer.phone ?? ''
		default:
			return ''
	}
}

function matchesTextOperator(
	value: string,
	operator: string,
	values: unknown[],
): boolean {
	const haystack = value.toLowerCase()
	const needle = String(values[0] ?? '').toLowerCase()

	switch (operator) {
		case 'contains':
			return haystack.includes(needle)
		case 'not_contains':
			return !haystack.includes(needle)
		case 'starts_with':
			return haystack.startsWith(needle)
		case 'ends_with':
			return haystack.endsWith(needle)
		case 'is':
			return haystack === needle
		case 'is_not':
			return haystack !== needle
		case 'empty':
			return haystack.trim().length === 0
		case 'not_empty':
			return haystack.trim().length > 0
		default:
			return true
	}
}

function matchesSelectOperator(
	value: string,
	operator: string,
	values: unknown[],
): boolean {
	const selected = values.map(String)

	switch (operator) {
		case 'is':
			return selected.length > 0 && selected[0] === value
		case 'is_not':
			return selected.length > 0 && selected[0] !== value
		case 'is_any_of':
			return selected.length === 0 || selected.includes(value)
		case 'is_none_of':
			return selected.length > 0 && !selected.includes(value)
		case 'has_any_of':
			return selected.length === 0 || selected.includes(value)
		case 'has_all_of':
			return selected.every((entry) => entry === value)
		case 'has_none_of':
			return !selected.includes(value)
		case 'empty':
			return value.trim().length === 0
		case 'not_empty':
			return value.trim().length > 0
		default:
			return true
	}
}

// A chip with no value yet (e.g. "Status is any of any status" right after
// Add Filter) narrows nothing, so it must not filter or count as a filter.
export function isActiveCustomerCondition(condition: FilterCondition) {
	if (condition.operator === 'empty' || condition.operator === 'not_empty') {
		return true
	}
	return condition.values.some((value) => String(value ?? '').trim() !== '')
}

function matchesCustomerCondition(
	customer: CustomerListItem,
	condition: FilterCondition,
): boolean {
	const value = getCustomerFieldValue(customer, condition.field)
	const matches =
		condition.field === 'status'
			? matchesSelectOperator(value, condition.operator, condition.values)
			: matchesTextOperator(value, condition.operator, condition.values)

	return condition.negated ? !matches : matches
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
	})

	// Guard customer PII access
	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)

	// Erasing a customer is destructive: only people who can change settings get
	// a token that tenant-api accepts for it.
	const canErase = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		orgSlug,
		{ canDelete: canErase },
	)

	return { jwt, tenantApiUrl, canErase }
}

function CustomerRow({
	customer,
	onEdit,
	onErase,
}: {
	customer: CustomerListItem
	onEdit: (customer: CustomerListItem) => void
	/** Set only for people allowed to erase a customer. */
	onErase?: (customer: CustomerListItem) => void
}) {
	return (
		<TableRow
			className="cursor-pointer"
			onClick={() => onEdit(customer)}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					onEdit(customer)
				}
			}}
			tabIndex={0}
		>
			<TableCell className="font-medium">{customer.name}</TableCell>
			<TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
				{customer.phone || '—'}
			</TableCell>
			<TableCell className="text-muted-foreground hidden text-sm md:table-cell">
				{customer.email || '—'}
			</TableCell>
			<TableCell>
				<Badge variant="outline">
					<span
						aria-hidden="true"
						className={cn(
							'size-1.5 rounded-full',
							customer.phoneVerified
								? 'bg-emerald-500'
								: 'bg-muted-foreground/64',
						)}
					/>
					{customer.phoneVerified ? 'Verified' : 'Unverified'}
				</Badge>
			</TableCell>
			<TableCell className="text-muted-foreground hidden text-sm lg:table-cell">
				{formatDistanceToNow(new Date(customer.createdAt), { addSuffix: true })}
			</TableCell>
			<TableCell
				className="text-right"
				onClick={(event) => event.stopPropagation()}
			>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Customer actions"
							>
								<Icon name="ellipsis" className="size-4" />
							</Button>
						}
					/>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => onEdit(customer)}>
							<Icon name="pencil" className="mr-2 size-4" />
							Edit
						</DropdownMenuItem>
						{onErase ? (
							<DropdownMenuItem
								variant="destructive"
								onClick={() => onErase(customer)}
							>
								<Icon name="trash-2" className="mr-2 size-4" />
								Erase data
							</DropdownMenuItem>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			</TableCell>
		</TableRow>
	)
}

export default function CustomersRoute() {
	const { jwt, tenantApiUrl, canErase } = useLoaderData<typeof loader>()
	const [erasingCustomer, setErasingCustomer] =
		useState<CustomerListItem | null>(null)
	const [isErasing, setIsErasing] = useState(false)
	const { _, i18n } = useLingui()
	const [eraseError, setEraseError] = useState<EraseErrorKind | null>(null)
	const [eraseConfirmation, setEraseConfirmation] = useState('')
	const eraseAlertRef = useRef<HTMLParagraphElement>(null)
	const [customers, setCustomers] = useState<CustomerListItem[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [filterQuery, setFilterQuery] = useState<FilterQuery>(() =>
		createFilterQuery(),
	)
	const [editingCustomer, setEditingCustomer] =
		useState<CustomerListItem | null>(null)
	const [editName, setEditName] = useState('')
	const [editEmail, setEditEmail] = useState('')
	const [isSaving, setIsSaving] = useState(false)
	const [saveError, setSaveError] = useState<string | null>(null)

	const fetchCustomers = useCallback(async () => {
		try {
			const res = await fetch(`${tenantApiUrl}/operator/customers`, {
				headers: { Authorization: `Bearer ${jwt}` },
			})
			if (!res.ok) {
				throw new Error('Failed to load customers')
			}
			const data = (await res.json()) as { customers?: CustomerListItem[] }
			setCustomers(data.customers ?? [])
			return true
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load customers')
			return false
		} finally {
			setLoading(false)
		}
	}, [jwt, tenantApiUrl])

	useEffect(() => {
		void fetchCustomers()
	}, [fetchCustomers])

	// After a failed erase, move focus to the message (the destructive button
	// is enabled again and would otherwise keep it).
	useEffect(() => {
		if (eraseError) eraseAlertRef.current?.focus()
	}, [eraseError])

	const filterConditions = useMemo(
		() =>
			flattenFilterConditions(filterQuery).filter(isActiveCustomerCondition),
		[filterQuery],
	)

	const filteredCustomers = useMemo(
		() =>
			customers.filter((customer) =>
				filterConditions.every((condition) =>
					matchesCustomerCondition(customer, condition),
				),
			),
		[customers, filterConditions],
	)

	// With no customers at all, no filter is why the list is empty.
	const hasFilters = customers.length > 0 && filterConditions.length > 0

	function openEditSheet(customer: CustomerListItem) {
		setEditingCustomer(customer)
		setEditName(customer.name)
		setEditEmail(customer.email ?? '')
		setSaveError(null)
	}

	async function handleSave(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!editingCustomer || editName.trim() === '') return

		setIsSaving(true)
		setSaveError(null)

		try {
			const res = await fetch(
				`${tenantApiUrl}/operator/customers/${editingCustomer.id}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${jwt}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						name: editName.trim(),
						email: editEmail.trim(),
					}),
				},
			)

			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as {
					error?: string
				} | null
				setSaveError(data?.error ?? 'Failed to update customer')
				return
			}

			const data = (await res.json()) as { customer: CustomerListItem }
			setCustomers((current) =>
				current.map((customer) =>
					customer.id === data.customer.id ? data.customer : customer,
				),
			)
			setEditingCustomer(null)
		} catch (err) {
			setSaveError(
				err instanceof Error ? err.message : 'Failed to update customer',
			)
		} finally {
			setIsSaving(false)
		}
	}

	const eraseTargets = erasingCustomer
		? new Intl.ListFormat(i18n.locale, {
				style: 'long',
				type: 'disjunction',
			}).format(eraseConfirmationTargets(erasingCustomer)) || 'erase'
		: ''
	const erasingLabel =
		erasingCustomer?.name || erasingCustomer?.phone || _(msg`this customer`)

	async function handleErase() {
		if (!erasingCustomer) return
		if (!matchesEraseConfirmation(erasingCustomer, eraseConfirmation)) return
		setIsErasing(true)
		setEraseError(null)
		let status: number | null = null
		try {
			const res = await fetch(
				`${tenantApiUrl}/operator/customers/${erasingCustomer.id}/erase`,
				{ method: 'POST', headers: { Authorization: `Bearer ${jwt}` } },
			)
			status = res.status
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as {
					code?: string
				} | null
				setEraseError(classifyEraseError(res.status, data?.code))
				return
			}
			// Customers sharing the phone are erased with this one and more than
			// one row can go, so reload the list instead of removing one row.
			const erasedId = erasingCustomer.id
			const reloaded = await fetchCustomers()
			if (!reloaded) {
				setCustomers((current) =>
					current.filter((customer) => customer.id !== erasedId),
				)
			}
			setErasingCustomer(null)
		} catch {
			setEraseError(classifyEraseError(status, null))
		} finally {
			setIsErasing(false)
		}
	}

	return (
		<WorkspacePage>
			<PageHeader
				title="Customers"
				description="Search, filter, and update customer contact details. Data is served from your tenant region."
			/>

			<WorkspaceToolbar>
				<Filters
					fields={CUSTOMER_FILTER_FIELDS}
					query={filterQuery}
					onQueryChange={setFilterQuery}
					showClear
					disabled={loading}
				/>
			</WorkspaceToolbar>

			{loading ? (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden sm:table-cell">Phone</TableHead>
								<TableHead className="hidden md:table-cell">Email</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="hidden lg:table-cell">Joined</TableHead>
								<TableHead className="w-16">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{Array.from({ length: 5 }).map((_, index) => (
								<TableRow key={index}>
									<TableCell>
										<Skeleton className="h-4 w-32" />
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<Skeleton className="h-4 w-24" />
									</TableCell>
									<TableCell className="hidden md:table-cell">
										<Skeleton className="h-4 w-36" />
									</TableCell>
									<TableCell>
										<Skeleton className="h-5 w-20" />
									</TableCell>
									<TableCell className="hidden lg:table-cell">
										<Skeleton className="h-4 w-24" />
									</TableCell>
									<TableCell>
										<Skeleton className="ml-auto h-8 w-8" />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			) : error ? (
				<p className="text-destructive text-sm">{error}</p>
			) : filteredCustomers.length === 0 ? (
				<EmptyState
					title="No customers found"
					description={
						hasFilters
							? 'Try adjusting your filters or clear them to see all customers.'
							: 'Customers appear here after they sign up on your site.'
					}
					icons={['users', 'user', 'search']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden sm:table-cell">Phone</TableHead>
								<TableHead className="hidden md:table-cell">Email</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="hidden lg:table-cell">Joined</TableHead>
								<TableHead className="w-16">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{filteredCustomers.map((customer) => (
								<CustomerRow
									key={customer.id}
									customer={customer}
									onEdit={openEditSheet}
									onErase={
										canErase
											? (target) => {
													setEraseError(null)
													setEraseConfirmation('')
													setErasingCustomer(target)
												}
											: undefined
									}
								/>
							))}
						</TableBody>
						<TableFooter>
							<TableRow>
								<TableCell colSpan={5}>
									{filteredCustomers.length === 1
										? '1 customer'
										: `${filteredCustomers.length} customers`}
								</TableCell>
								<TableCell />
							</TableRow>
						</TableFooter>
					</Table>
				</Frame>
			)}

			<Sheet
				open={editingCustomer !== null}
				onOpenChange={(open) => {
					if (!open && !isSaving) {
						setEditingCustomer(null)
					}
				}}
			>
				<SheetContent
					side="right"
					className="flex w-full flex-col gap-0 sm:max-w-lg"
				>
					<SheetHeader className="border-b">
						<SheetTitle>Edit customer</SheetTitle>
						<SheetDescription>
							Update name and email. Phone number is managed through site
							sign-in.
						</SheetDescription>
					</SheetHeader>

					{editingCustomer ? (
						<form
							onSubmit={handleSave}
							className="flex min-h-0 flex-1 flex-col"
						>
							<div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
								<div className="space-y-2">
									<Label htmlFor="customer-name">Name</Label>
									<Input
										id="customer-name"
										value={editName}
										onChange={(e) => setEditName(e.target.value)}
										required
										autoComplete="name"
									/>
								</div>

								<div className="space-y-2">
									<Label htmlFor="customer-email">Email</Label>
									<Input
										id="customer-email"
										type="email"
										value={editEmail}
										onChange={(e) => setEditEmail(e.target.value)}
										placeholder="Optional"
										autoComplete="email"
									/>
								</div>

								{editingCustomer.phone ? (
									<div className="space-y-1">
										<Label className="text-muted-foreground">Phone</Label>
										<p className="text-sm">{editingCustomer.phone}</p>
									</div>
								) : null}

								{saveError ? (
									<p className="text-destructive text-sm">{saveError}</p>
								) : null}
							</div>

							<SheetFooter className="border-t sm:flex-row sm:justify-end">
								<Button
									type="button"
									variant="outline"
									disabled={isSaving}
									onClick={() => setEditingCustomer(null)}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									disabled={isSaving || editName.trim() === ''}
								>
									{isSaving ? 'Saving...' : 'Save changes'}
								</Button>
							</SheetFooter>
						</form>
					) : null}
				</SheetContent>
			</Sheet>

			<AlertDialog
				open={erasingCustomer !== null}
				onOpenChange={(open) => {
					if (!open && !isErasing) setErasingCustomer(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Erase this customer&apos;s data?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This permanently deletes the account, login sessions,
								subscriptions, saved cards, journeys, messages and phone calls
								for {erasingLabel}. Orders stay for your records, without a link
								to the person. This cannot be undone.
							</Trans>
						</AlertDialogDescription>
						<ul className="text-muted-foreground list-disc ps-5 text-sm">
							<li>
								<Trans>
									Every customer record with the same phone number is erased
									too.
								</Trans>
							</li>
							<li>
								<Trans>
									Form submissions are redacted on a best-effort basis: only
									ones that contain the exact phone number or email address are
									found. Backups are not changed.
								</Trans>
							</li>
						</ul>
					</AlertDialogHeader>
					{erasingCustomer ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="erase-confirmation">
								<Trans>Type {eraseTargets} to confirm</Trans>
							</Label>
							<Input
								id="erase-confirmation"
								value={eraseConfirmation}
								onChange={(event) => setEraseConfirmation(event.target.value)}
								autoComplete="off"
								disabled={isErasing}
								aria-describedby={eraseError ? 'erase-error' : undefined}
							/>
						</div>
					) : null}
					{eraseError ? (
						<p
							id="erase-error"
							ref={eraseAlertRef}
							tabIndex={-1}
							className="text-destructive text-sm"
							role="alert"
						>
							{_(ERASE_ERROR_MESSAGES[eraseError])}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isErasing}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={
								isErasing ||
								!erasingCustomer ||
								!matchesEraseConfirmation(erasingCustomer, eraseConfirmation)
							}
							onClick={(event) => {
								// Keep the dialog open until the request finishes.
								event.preventDefault()
								void handleErase()
							}}
						>
							{isErasing ? (
								<Trans>Erasing...</Trans>
							) : (
								<Trans>Erase data</Trans>
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</WorkspacePage>
	)
}
