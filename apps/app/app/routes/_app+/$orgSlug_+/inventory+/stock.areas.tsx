import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_PERMISSIONS,
	listStorageAreasResultSchema,
	type StorageArea,
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
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useNotifyInventoryChanged } from '#app/components/inventory/inventory-prefs.tsx'
import { useStockContext } from '#app/components/inventory/stock-context.ts'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { moveId } from '#app/utils/inventory/areas.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { type Route } from './+types/stock.areas.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY],
	})
	return null
}

/**
 * Storage areas: where things are kept, in the order you walk. Counts follow
 * this order. Rename, reorder with the arrows, archive (items kept only
 * there move to "Not in an area").
 */
export default function InventoryStorageAreasRoute() {
	const { t, i18n } = useLingui()
	const ctx = useStockContext()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const query = useInventoryQuery(
		`/storage-areas?locationId=${encodeURIComponent(ctx.activeLocationId)}`,
		listStorageAreasResultSchema,
	)
	const { reload } = query
	const areas = query.data?.areas ?? []

	const label = {
		added: (name: string) => t`${name} added.`,
		archived: (name: string) => t`${name} archived.`,
		moveUp: (name: string) => t`Move ${name} up`,
		moveDown: (name: string) => t`Move ${name} down`,
		rename: (name: string) => t`Rename ${name}`,
		archive: (name: string) => t`Archive ${name}`,
	}
	const [newName, setNewName] = useState('')
	const [editingId, setEditingId] = useState<string | null>(null)
	const [editName, setEditName] = useState('')
	const [archiveTarget, setArchiveTarget] = useState<StorageArea | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function run(action: () => Promise<unknown>, done?: string) {
		if (busy) return false
		setBusy(true)
		setError(null)
		try {
			await action()
			if (done) toast.success(done)
			notifyChanged()
			reload()
			ctx.reload()
			return true
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
			return false
		} finally {
			setBusy(false)
		}
	}

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const name = newName.trim()
		if (name === '') return
		const ok = await run(
			() =>
				request('/storage-areas', {
					method: 'POST',
					body: JSON.stringify({ locationId: ctx.activeLocationId, name }),
				}),
			label.added(name),
		)
		if (ok) setNewName('')
	}

	async function rename(area: StorageArea) {
		const name = editName.trim()
		if (name === '' || name === area.name) {
			setEditingId(null)
			return
		}
		const ok = await run(() =>
			request(`/storage-areas/${encodeURIComponent(area.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ expectedVersion: area.version, name }),
			}),
		)
		if (ok) setEditingId(null)
	}

	async function move(index: number, delta: -1 | 1) {
		const ids = moveId(
			areas.map((area) => area.id),
			index,
			delta,
		)
		await run(() =>
			request('/storage-areas/reorder', {
				method: 'POST',
				body: JSON.stringify({
					locationId: ctx.activeLocationId,
					areaIds: ids,
				}),
			}),
		)
	}

	async function archive(area: StorageArea) {
		const ok = await run(
			() =>
				request(`/storage-areas/${encodeURIComponent(area.id)}/archive`, {
					method: 'POST',
					body: JSON.stringify({ expectedVersion: area.version }),
				}),
			label.archived(area.name),
		)
		if (ok) setArchiveTarget(null)
	}

	const archiveName = archiveTarget?.name ?? ''

	return (
		<SheetPanel
			title={<Trans>Storage areas</Trans>}
			description={
				<Trans>
					List where you keep things in the order you walk, so counts follow the
					same path.
				</Trans>
			}
		>
			<form
				onSubmit={(event) => void add(event)}
				className="flex items-center gap-2"
				data-testid="areas-add-form"
			>
				<Input
					value={newName}
					onChange={(event) => setNewName(event.target.value)}
					placeholder={t`Walk-in fridge`}
					aria-label={t`New storage area`}
					maxLength={80}
					dir="auto"
					className="h-11 md:h-8"
					disabled={busy}
					data-testid="areas-new-name"
				/>
				<Button
					type="submit"
					disabled={busy || newName.trim() === ''}
					data-testid="areas-add"
				>
					<Icon name="plus" />
					<Trans>Add</Trans>
				</Button>
			</form>

			{error ? (
				<Alert variant="destructive" data-testid="areas-error">
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
						<Trans>Loading storage areas</Trans>
					</span>
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : areas.length === 0 ? (
				<EmptyState
					title={<Trans>No storage areas yet</Trans>}
					description={
						<Trans>
							Add your fridges, freezers and shelves above. You can put each
							item in one when you add it.
						</Trans>
					}
					icons={['layers', 'list', 'folder']}
				/>
			) : (
				<ol className="flex flex-col divide-y" data-testid="areas-list">
					{areas.map((area, index) => (
						<li
							key={area.id}
							className="flex min-h-12 items-center gap-2 py-1"
							data-testid={`area-${area.id}`}
						>
							{editingId === area.id ? (
								<form
									className="flex flex-1 items-center gap-2"
									onSubmit={(event) => {
										event.preventDefault()
										void rename(area)
									}}
								>
									<Input
										value={editName}
										onChange={(event) => setEditName(event.target.value)}
										aria-label={t`Storage area name`}
										maxLength={80}
										dir="auto"
										autoFocus
										className="h-11 md:h-8"
										disabled={busy}
									/>
									<Button type="submit" size="sm" disabled={busy}>
										<Trans>Save</Trans>
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() => setEditingId(null)}
									>
										<Trans>Cancel</Trans>
									</Button>
								</form>
							) : (
								<>
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="font-medium wrap-anywhere">
											{area.name}
										</span>
										<span className="text-muted-foreground text-xs">
											<Plural
												value={area.itemCount}
												one="# item"
												other="# items"
											/>
										</span>
									</div>
									<div className="flex shrink-0 items-center">
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-11 md:size-8"
											aria-label={label.moveUp(area.name)}
											disabled={busy || index === 0}
											onClick={() => void move(index, -1)}
										>
											<Icon name="chevron-up" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-11 md:size-8"
											aria-label={label.moveDown(area.name)}
											disabled={busy || index === areas.length - 1}
											onClick={() => void move(index, 1)}
										>
											<Icon name="chevron-down" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-11 md:size-8"
											aria-label={label.rename(area.name)}
											disabled={busy}
											onClick={() => {
												setEditingId(area.id)
												setEditName(area.name)
											}}
										>
											<Icon name="pencil" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-11 md:size-8"
											aria-label={label.archive(area.name)}
											disabled={busy}
											onClick={() => setArchiveTarget(area)}
										>
											<Icon name="trash-2" />
										</Button>
									</div>
								</>
							)}
						</li>
					))}
				</ol>
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
							<Trans>Archive this storage area?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								<span className="wrap-anywhere">{archiveName}</span> is removed
								from your walk. Items kept only there move to "Not in an area".
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
							data-testid="areas-archive-confirm"
						>
							<Trans>Archive</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SheetPanel>
	)
}
