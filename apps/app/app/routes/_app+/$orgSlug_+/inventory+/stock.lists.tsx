import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type CountList,
	INVENTORY_PERMISSIONS,
	listCountListsResultSchema,
	listItemsResultSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
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
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Skeleton } from '@repo/ui/skeleton'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useNotifyInventoryChanged } from '#app/components/inventory/inventory-prefs.tsx'
import { useStockContext } from '#app/components/inventory/stock-context.ts'
import { TextField } from '#app/components/staff/controls.tsx'
import { SheetForm, SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { type Route } from './+types/stock.lists.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY],
	})
	return null
}

/**
 * Count lists ("Proteins daily", "Bar weekly"): the items a count walks
 * through, so a partial count does not mean the whole kitchen.
 */
export default function InventoryCountListsRoute() {
	const { t, i18n } = useLingui()
	const ctx = useStockContext()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const query = useInventoryQuery(
		`/count-lists?locationId=${encodeURIComponent(ctx.activeLocationId)}`,
		listCountListsResultSchema,
	)
	const { reload } = query
	const lists = query.data?.lists ?? []
	const label = {
		archived: (name: string) => t`${name} archived.`,
		edit: (name: string) => t`Edit ${name}`,
		archive: (name: string) => t`Archive ${name}`,
	}
	const [editing, setEditing] = useState<CountList | 'new' | null>(null)
	const [archiveTarget, setArchiveTarget] = useState<CountList | null>(null)
	const archiveName = archiveTarget?.name ?? ''
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function archive(list: CountList) {
		setBusy(true)
		setError(null)
		try {
			await request(`/count-lists/${encodeURIComponent(list.id)}/archive`, {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: list.version }),
			})
			toast.success(label.archived(list.name))
			notifyChanged()
			reload()
			setArchiveTarget(null)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusy(false)
		}
	}

	if (editing !== null) {
		return (
			<CountListEditor
				list={editing === 'new' ? null : editing}
				locationId={ctx.activeLocationId}
				onDone={() => {
					setEditing(null)
					reload()
				}}
				onCancel={() => setEditing(null)}
			/>
		)
	}

	return (
		<SheetPanel
			title={<Trans>Count lists</Trans>}
			description={
				<Trans>
					Group the items you count together, like "Proteins daily" or "Bar
					weekly".
				</Trans>
			}
		>
			<div>
				<Button onClick={() => setEditing('new')} data-testid="lists-new">
					<Icon name="plus" />
					<Trans>New count list</Trans>
				</Button>
			</div>

			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{query.error && !query.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(query.error))}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : query.loading && !query.data ? (
				<div role="status" className="flex flex-col gap-2">
					<span className="sr-only">
						<Trans>Loading count lists</Trans>
					</span>
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : lists.length === 0 ? (
				<EmptyState
					title={<Trans>No count lists yet</Trans>}
					description={
						<Trans>
							A count list is a shortlist of items you count together. Counting
							everything still works without one.
						</Trans>
					}
					icons={['list', 'layers', 'list-plus']}
				/>
			) : (
				<ul className="flex flex-col divide-y" data-testid="lists-list">
					{lists.map((list) => (
						<li
							key={list.id}
							className="flex min-h-12 items-center gap-2 py-1"
							data-testid={`list-${list.id}`}
						>
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="font-medium wrap-anywhere">{list.name}</span>
								<span className="text-muted-foreground text-xs">
									<Plural
										value={list.itemIds.length}
										one="# item"
										other="# items"
									/>
								</span>
							</div>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-11 md:size-8"
								aria-label={label.edit(list.name)}
								onClick={() => setEditing(list)}
							>
								<Icon name="pencil" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-11 md:size-8"
								aria-label={label.archive(list.name)}
								onClick={() => setArchiveTarget(list)}
							>
								<Icon name="trash-2" />
							</Button>
						</li>
					))}
				</ul>
			)}

			<AlertDialog
				open={archiveTarget !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setArchiveTarget(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Archive this count list?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								<span className="wrap-anywhere">{archiveName}</span> is removed.
								The items stay in Stock.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy}
							onClick={() => archiveTarget && void archive(archiveTarget)}
						>
							<Trans>Archive</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SheetPanel>
	)
}

const SEARCH_DELAY_MS = 250

function CountListEditor({
	list,
	locationId,
	onDone,
	onCancel,
}: {
	list: CountList | null
	locationId: string
	onDone: () => void
	onCancel: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const checkId = useId()
	const [name, setName] = useState(list?.name ?? '')
	const [selected, setSelected] = useState<ReadonlySet<string>>(
		new Set(list?.itemIds ?? []),
	)
	const [search, setSearch] = useState('')
	const [debounced, setDebounced] = useState('')
	const [attempted, setAttempted] = useState(false)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DELAY_MS)
		return () => clearTimeout(timer)
	}, [search])

	const params = new URLSearchParams({ locationId, limit: '200' })
	if (debounced) params.set('q', debounced)
	const items = useInventoryQuery(
		`/items?${params.toString()}`,
		listItemsResultSchema,
	)

	const nameProblem = attempted && name.trim() === ''
	const itemsProblem = attempted && selected.size === 0

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setAttempted(true)
		if (pending || name.trim() === '' || selected.size === 0) return
		setPending(true)
		setError(null)
		try {
			const itemIds = [...selected]
			if (list) {
				await request(`/count-lists/${encodeURIComponent(list.id)}`, {
					method: 'PATCH',
					body: JSON.stringify({
						expectedVersion: list.version,
						name: name.trim(),
						itemIds,
					}),
				})
			} else {
				await request('/count-lists', {
					method: 'POST',
					body: JSON.stringify({ locationId, name: name.trim(), itemIds }),
				})
			}
			toast.success(t`Count list saved.`)
			notifyChanged()
			onDone()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	const selectedCount = selected.size
	return (
		<SheetForm
			title={list ? t`Edit count list` : t`New count list`}
			description={t`Choose the items this list counts.`}
			onSubmit={(event) => void save(event)}
			footer={
				<>
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={pending}
					>
						<Trans>Back</Trans>
					</Button>
					<Button type="submit" disabled={pending} data-testid="lists-save">
						{pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</>
			}
		>
			{error ? (
				<Alert variant="destructive" data-testid="lists-error">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<TextField
				label={<Trans>Name</Trans>}
				value={name}
				onChange={(event) => setName(event.target.value)}
				maxLength={80}
				dir="auto"
				placeholder={t`Proteins daily`}
				error={nameProblem ? t`Enter a name.` : null}
				data-testid="lists-name"
			/>
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-sm font-medium">
					<Trans>Items</Trans>{' '}
					<span
						className="text-muted-foreground font-normal"
						aria-live="polite"
					>
						<Trans>({selectedCount} chosen)</Trans>
					</span>
				</legend>
				<Input
					type="search"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder={t`Search items`}
					aria-label={t`Search items`}
					className="h-11 md:h-8"
				/>
				{itemsProblem ? (
					<p className="text-destructive text-sm" role="alert">
						<Trans>Choose at least one item.</Trans>
					</p>
				) : null}
				{items.error && !items.data ? (
					<p className="text-destructive text-sm" role="alert">
						{i18n._(inventoryErrorMessage(items.error))}
					</p>
				) : (
					<ul className="flex flex-col" data-testid="lists-items">
						{(items.data?.items ?? []).map((item) => (
							<li
								key={item.id}
								className="flex min-h-11 items-center gap-3 border-b py-1 last:border-b-0"
							>
								<Checkbox
									id={`${checkId}-${item.id}`}
									checked={selected.has(item.id)}
									onCheckedChange={(checked) =>
										setSelected((current) => {
											const next = new Set(current)
											if (checked) next.add(item.id)
											else next.delete(item.id)
											return next
										})
									}
								/>
								<Label
									htmlFor={`${checkId}-${item.id}`}
									className="flex-1 cursor-pointer font-normal wrap-anywhere"
								>
									{item.name}
								</Label>
							</li>
						))}
					</ul>
				)}
			</fieldset>
		</SheetForm>
	)
}
