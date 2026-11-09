import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	countSheetSchema,
	countSummarySchema,
	type UnitRef,
} from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
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
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { Skeleton } from '@repo/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { WorkspaceTabDivider } from '@repo/ui/workspace'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { CountStatusBadge } from '#app/components/inventory/count-status-badge.tsx'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { useCountEntrySync } from '#app/hooks/use-count-entry-sync.ts'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { canApproveCount } from '#app/utils/inventory/count-review.ts'
import {
	type CountRow,
	countProgress,
	initialSheetAmounts,
	isRowCounted,
	othersQuantity,
	type RowSaveState,
	rowSaveState,
	rowUnitChoices,
	type SheetAmounts,
	sheetTabs,
	tabProgress,
} from '#app/utils/inventory/count-sheet.ts'
import { entryStep, unitChoices } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	inventoryCountReviewPath,
	inventoryTabPath,
} from '#app/utils/inventory/nav.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

/** A pause after the last tap on − or +, before the entry is queued. */
export const COMMIT_DELAY_MS = 700

function useOnline(): boolean {
	return useSyncExternalStore(
		(listener) => {
			window.addEventListener('online', listener)
			window.addEventListener('offline', listener)
			return () => {
				window.removeEventListener('online', listener)
				window.removeEventListener('offline', listener)
			}
		},
		() => navigator.onLine,
		() => true,
	)
}

function slotOf(key: string, unit: UnitRef): string {
	return `${key}|${unit}`
}

/**
 * The counting screen: built for a phone held in one hand, in a walk-in with
 * no signal. Fields start blank; each entry goes to the offline queue as soon
 * as the field loses focus (or after a short pause on − and +), so a dropped
 * connection loses nothing and a row never looks saved when it is not.
 */
export function CountingScreen({
	orgSlug,
	countId,
	canEdit,
	canSeeCost,
	search,
}: {
	orgSlug: string
	countId: string
	/** `update:inventory:any`, and not impersonating. */
	canEdit: boolean
	canSeeCost: boolean
	/** The query string to keep on links (`?locationId=…`), with its `?`. */
	search: string
}) {
	const { t, i18n } = useLingui()
	const navigate = useNavigate()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const online = useOnline()

	const sheet = useInventoryQuery(
		`/counts/${encodeURIComponent(countId)}`,
		countSheetSchema,
	)
	const { reload } = sheet
	const count = sheet.data?.count ?? null
	const status = count?.status ?? null
	const counting = status === 'counting' && canEdit

	const { sync, snapshot } = useCountEntrySync({
		orgSlug,
		countId,
		enabled: counting,
	})

	const tabs = useMemo(
		() => (sheet.data ? sheetTabs(sheet.data) : []),
		[sheet.data],
	)

	// What each row holds is local state, started once from the region and the
	// offline queue; a later reload never rewrites what is being typed.
	const [amounts, setAmounts] = useState<SheetAmounts | null>(null)
	const amountsRef = useRef<SheetAmounts>({})
	const committedRef = useRef(new Map<string, number | null>())
	const dirtyRef = useRef(new Set<string>())
	const [, setDirtyCount] = useState(0)
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
	useEffect(() => {
		if (amounts !== null || !sheet.data) return
		const initial = initialSheetAmounts(tabs, snapshot.pending)
		amountsRef.current = initial
		for (const [key, byUnit] of Object.entries(initial)) {
			for (const [unit, value] of Object.entries(byUnit)) {
				committedRef.current.set(slotOf(key, unit), value ?? null)
			}
		}
		setAmounts(initial)
	}, [amounts, sheet.data, tabs, snapshot.pending])

	const [activeUnits, setActiveUnits] = useState<Record<string, UnitRef>>({})
	const [activeTab, setActiveTab] = useState<string | null>(null)
	const currentTab =
		tabs.find((tab) => tab.key === activeTab) ?? tabs[0] ?? null

	const rowsByKey = useMemo(() => {
		const map = new Map<string, CountRow>()
		for (const tab of tabs) for (const row of tab.rows) map.set(row.key, row)
		return map
	}, [tabs])

	const commit = useCallback(
		(key: string, unit: UnitRef) => {
			const slot = slotOf(key, unit)
			const timer = timers.current.get(slot)
			if (timer) clearTimeout(timer)
			timers.current.delete(slot)
			const row = rowsByKey.get(key)
			if (!row || !dirtyRef.current.has(slot)) return
			dirtyRef.current.delete(slot)
			setDirtyCount(dirtyRef.current.size)
			const value = amountsRef.current[key]?.[unit] ?? null
			if ((committedRef.current.get(slot) ?? null) === value) return
			committedRef.current.set(slot, value)
			void sync.submit({
				clientId: newClientId('c'),
				itemId: row.itemId,
				areaId: row.areaId,
				amount: value,
				unit,
			})
		},
		[rowsByKey, sync],
	)

	const commitAll = useCallback(() => {
		// Committing a slot removes it from the set, which is safe while iterating.
		for (const slot of dirtyRef.current) {
			const unitAt = slot.lastIndexOf('|')
			commit(slot.slice(0, unitAt), slot.slice(unitAt + 1) as UnitRef)
		}
	}, [commit])

	// Whatever is typed is queued before the page goes away.
	useEffect(() => {
		const pending = timers.current
		window.addEventListener('pagehide', commitAll)
		return () => {
			window.removeEventListener('pagehide', commitAll)
			commitAll()
			for (const timer of pending.values()) clearTimeout(timer)
		}
	}, [commitAll])

	function change(row: CountRow, unit: UnitRef, value: number | null) {
		const current = amountsRef.current
		const next: SheetAmounts = {
			...current,
			[row.key]: { ...current[row.key], [unit]: value },
		}
		amountsRef.current = next
		setAmounts(next)
		const slot = slotOf(row.key, unit)
		dirtyRef.current.add(slot)
		setDirtyCount(dirtyRef.current.size)
		const pending = timers.current.get(slot)
		if (pending) clearTimeout(pending)
		timers.current.set(
			slot,
			setTimeout(() => commit(row.key, unit), COMMIT_DELAY_MS),
		)
	}

	// Anything counted elsewhere (another phone) shows up when the person returns.
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') reload()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => document.removeEventListener('visibilitychange', onVisible)
	}, [reload])

	const [sending, setSending] = useState(false)
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [finishError, setFinishError] = useState<string | null>(null)
	const backHref = `${inventoryTabPath(orgSlug, 'counts')}${search}`
	const reviewHref = `${inventoryCountReviewPath(orgSlug, countId)}${search}`
	const manager = canApproveCount({ canEdit, canSeeCost })

	const sheetAmounts = amounts ?? {}
	const progress = countProgress(tabs, sheetAmounts)
	const doneCount = progress.counted
	const totalCount = progress.total
	const waiting = snapshot.pending.length
	const queuedOnly = snapshot.pending.filter(
		(entry) => !snapshot.sending.has(entry.clientId),
	).length

	async function sendForReview() {
		if (!count) return
		setSending(true)
		setFinishError(null)
		try {
			const sent = countSummarySchema.parse(
				await request(`/counts/${encodeURIComponent(countId)}/send`, {
					method: 'POST',
					body: JSON.stringify({ expectedVersion: count.version }),
				}),
			)
			notifyChanged()
			if (manager) {
				void navigate(reviewHref)
			} else {
				toast.success(t`Sent for approval.`)
				void navigate(backHref)
			}
			return sent
		} catch (caught) {
			setFinishError(i18n._(inventorySaveErrorMessage(caught)))
			reload()
		} finally {
			setSending(false)
		}
	}

	async function finish() {
		if (sending) return
		setFinishError(null)
		setSending(true)
		commitAll()
		await sync.flush()
		setSending(false)
		if (sync.getSnapshot().pending.length > 0) {
			setFinishError(
				t`Some entries have not reached the server yet. Check your connection and try Finish again; nothing is lost.`,
			)
			return
		}
		if (progress.counted < progress.total) {
			setConfirmOpen(true)
			return
		}
		await sendForReview()
	}

	if (sheet.error && !sheet.data) {
		return (
			<div className="mx-auto w-full max-w-3xl px-4 py-6">
				<Alert variant="destructive" data-testid="count-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(sheet.error))}
					</AlertDescription>
					<AlertAction>
						<Button variant="outline" onClick={reload}>
							<Trans>Try again</Trans>
						</Button>
					</AlertAction>
				</Alert>
			</div>
		)
	}

	if (!sheet.data || !count) {
		return (
			<div
				role="status"
				className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6"
				data-testid="count-loading"
			>
				<span className="sr-only">
					<Trans>Loading the count</Trans>
				</span>
				<Skeleton className="h-8 w-1/2" />
				<Skeleton className="h-24 w-full rounded-xl" />
				<Skeleton className="h-24 w-full rounded-xl" />
			</div>
		)
	}

	const title = count.listName ?? t`Full count`
	const closed = snapshot.closed || (status !== null && status !== 'counting')

	return (
		<div className="flex flex-1 flex-col" data-testid="counting-screen">
			<header className="border-border bg-background/95 sticky top-0 z-20 w-full border-b backdrop-blur-sm">
				<div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
					<Button
						type="button"
						variant="secondary"
						size="icon-sm"
						render={<Link to={backHref} />}
						aria-label={t`Back to counts`}
						className="size-8 shrink-0"
					>
						<Icon name="arrow-left" className="size-4 rtl:rotate-180" />
					</Button>
					<div className="flex min-w-0 flex-1 flex-col">
						<h1 className="truncate text-base font-medium tracking-tight wrap-anywhere">
							{title}
						</h1>
						<p
							className="text-muted-foreground text-xs tabular-nums"
							data-testid="count-progress"
						>
							<Trans>
								<bdi dir="ltr">{doneCount}</bdi> of{' '}
								<bdi dir="ltr">{totalCount}</bdi> counted
							</Trans>
						</p>
					</div>
					<div className="flex items-center gap-2">
						{snapshot.sending.size > 0 ? (
							<span
								className="text-muted-foreground flex items-center gap-1 text-xs"
								data-testid="count-saving"
							>
								<Icon name="loader" className="size-3 animate-spin" />
								<Trans>Saving…</Trans>
							</span>
						) : null}
						{status && status !== 'counting' ? (
							<CountStatusBadge status={status} />
						) : null}
						{counting ? (
							<Button
								type="button"
								onClick={() => void finish()}
								disabled={sending}
								data-testid="count-finish"
							>
								{sending ? (
									<Icon name="loader" className="animate-spin" />
								) : null}
								<Trans>Finish</Trans>
							</Button>
						) : status === 'in_review' ? (
							<Button
								render={<Link to={reviewHref} />}
								data-testid="count-open-review"
							>
								<Trans>Review</Trans>
							</Button>
						) : null}
					</div>
				</div>
			</header>

			<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
				{!online && counting ? (
					<Alert data-testid="count-offline">
						<Icon name="cloud-off" />
						<AlertDescription>
							<Trans>
								You are offline. Keep counting: entries are kept on this device
								and sent when the connection returns.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				{counting && (snapshot.failed.size > 0 || queuedOnly > 0) ? (
					<Alert data-testid="count-queue-banner">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<Plural
								value={waiting}
								one="# entry waiting to send"
								other="# entries waiting to send"
							/>
						</AlertDescription>
						<AlertAction>
							<Button
								variant="outline"
								size="sm"
								onClick={() => void sync.flush()}
								data-testid="count-queue-retry"
							>
								<Icon name="refresh-cw" />
								<Trans>Send now</Trans>
							</Button>
						</AlertAction>
					</Alert>
				) : null}

				{snapshot.refused.length > 0 ? (
					<Alert variant="destructive" data-testid="count-refused">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<Plural
								value={snapshot.refused.length}
								one="# entry could not be saved and was left out. Check that item and enter it again."
								other="# entries could not be saved and were left out. Check those items and enter them again."
							/>
						</AlertDescription>
					</Alert>
				) : null}

				{finishError ? (
					<Alert variant="destructive" data-testid="count-finish-error">
						<AlertDescription>{finishError}</AlertDescription>
					</Alert>
				) : null}

				{closed && status === 'counting' ? (
					<Alert data-testid="count-closed">
						<AlertDescription>
							<Trans>
								This count no longer takes entries. Open Counts to see where it
								is.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				{status === 'in_review' ? (
					<Alert data-testid="count-in-review">
						<AlertDescription>
							<Trans>
								This count was sent for review. Open the review to check it, or
								reopen it to keep counting.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				{status === 'counting' && !canEdit ? (
					<Alert data-testid="count-read-only">
						<AlertDescription>
							<Trans>You can look at this count but not change it.</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				{tabs.length > 1 ? (
					<Tabs
						value={currentTab?.key ?? ''}
						onValueChange={(next) => setActiveTab(String(next))}
					>
						<WorkspaceTabDivider>
							<div className="-mx-4 [scrollbar-width:none] overflow-x-auto px-4 [&::-webkit-scrollbar]:hidden">
								<TabsList variant="line" aria-label={t`Storage areas`}>
									{tabs.map((tab) => {
										const done = tabProgress(tab, sheetAmounts)
										return (
											<TabsTrigger
												key={tab.key}
												value={tab.key}
												className="h-11 shrink-0 md:h-9"
												data-testid={`count-tab-${tab.key}`}
											>
												<span className="wrap-anywhere">
													{tab.name ?? t`Not in an area`}
												</span>
												<bdi
													dir="ltr"
													className="text-muted-foreground text-xs tabular-nums"
												>
													{done.counted}/{done.total}
												</bdi>
											</TabsTrigger>
										)
									})}
								</TabsList>
							</div>
						</WorkspaceTabDivider>
					</Tabs>
				) : null}

				{tabs.length === 0 ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="count-empty"
					>
						<Trans>
							There is nothing to count here. Add items to a storage area, or
							pick another count list.
						</Trans>
					</p>
				) : (
					<ul
						className="flex flex-col gap-3"
						data-testid="count-rows"
						aria-label={currentTab?.name ?? t`Items`}
					>
						{currentTab?.rows.map((row) => (
							<CountRowView
								key={row.key}
								row={row}
								amounts={sheetAmounts}
								editable={counting && !snapshot.closed}
								activeUnit={activeUnits[row.key] ?? row.countUnit}
								onActiveUnit={(unit) =>
									setActiveUnits((current) => ({ ...current, [row.key]: unit }))
								}
								saveState={rowSaveState({
									row,
									amounts: sheetAmounts,
									snapshot,
									dirty: [...dirtyRef.current].some((slot) =>
										slot.startsWith(`${row.key}|`),
									),
								})}
								onChange={(unit, value) => change(row, unit, value)}
								onCommit={(unit) => commit(row.key, unit)}
								onRetry={() => void sync.flush()}
								quantity={quantity}
							/>
						))}
					</ul>
				)}
			</div>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Some items are not counted</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Plural
								value={progress.total - progress.counted}
								one="# item has no count yet. You can send now and choose in the review whether it stays as it was or is none left."
								other="# items have no count yet. You can send now and choose in the review whether each stays as it was or is none left."
							/>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel data-testid="count-confirm-back">
							<Trans>Keep counting</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirmOpen(false)
								void sendForReview()
							}}
							data-testid="count-confirm-send"
						>
							{manager ? <Trans>Send for review</Trans> : <Trans>Send</Trans>}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

function SaveStatus({
	state,
	onRetry,
}: {
	state: RowSaveState
	onRetry: () => void
}) {
	return (
		<span
			className="flex min-h-5 items-center gap-1.5 text-xs"
			aria-live="polite"
			data-testid="count-row-status"
			data-state={state}
		>
			{state === 'saving' ? (
				<span className="text-muted-foreground flex items-center gap-1">
					<Icon name="loader" className="size-3 animate-spin" />
					<Trans>Saving…</Trans>
				</span>
			) : state === 'saved' ? (
				<span className="text-success flex items-center gap-1">
					<Icon name="check" className="size-3" />
					<Trans>Saved</Trans>
				</span>
			) : state === 'waiting' ? (
				<span className="text-warning flex items-center gap-1">
					<Icon name="cloud-off" className="size-3" />
					<Trans>Waiting to send</Trans>
				</span>
			) : state === 'failed' ? (
				<span className="text-destructive flex items-center gap-2">
					<Icon name="alert-triangle" className="size-3" />
					<Trans>Not saved yet</Trans>
					<Button
						type="button"
						variant="outline"
						size="xs"
						onClick={onRetry}
						data-testid="count-row-retry"
					>
						<Trans>Retry</Trans>
					</Button>
				</span>
			) : null}
		</span>
	)
}

function CountRowView({
	row,
	amounts,
	editable,
	activeUnit,
	onActiveUnit,
	saveState,
	onChange,
	onCommit,
	onRetry,
	quantity,
}: {
	row: CountRow
	amounts: SheetAmounts
	editable: boolean
	activeUnit: UnitRef
	onActiveUnit: (unit: UnitRef) => void
	saveState: RowSaveState
	onChange: (unit: UnitRef, value: number | null) => void
	onCommit: (unit: UnitRef) => void
	onRetry: () => void
	quantity: ReturnType<typeof useQuantityFormat>
}) {
	const { t } = useLingui()
	const name = row.name
	const choices = rowUnitChoices(
		row,
		unitChoices(row.baseUnit, row.units, quantity.system),
	)
	const value = amounts[row.key]?.[activeUnit] ?? null
	const unitName = quantity.unitName(activeUnit, row.units)
	const others = othersQuantity(row)
	const othersText =
		others !== null && others > 0
			? quantity.format(others, {
					baseUnit: row.baseUnit,
					countUnit: row.countUnit,
					units: row.units,
				})
			: ''
	const typedElsewhere = Object.entries(amounts[row.key] ?? {}).filter(
		([unit, amount]) => unit !== activeUnit && typeof amount === 'number',
	)
	const showFractions =
		row.baseUnit === 'piece' || activeUnit.startsWith('unit:')
	const counted = isRowCounted(row, amounts)

	return (
		<li
			className="bg-card flex flex-col gap-3 rounded-xl border p-3 md:flex-row md:items-center md:justify-between"
			data-testid={`count-row-${row.key}`}
			data-counted={counted}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<span className="font-medium wrap-anywhere">{row.name}</span>
				<span className="text-muted-foreground text-xs">
					<Trans>
						Count in <bdi dir="ltr">{unitName}</bdi>
					</Trans>
				</span>
				{others !== null && others > 0 && editable ? (
					<span
						className="text-muted-foreground text-xs"
						data-testid="count-row-others"
					>
						<Trans>
							Someone else also counted <bdi dir="ltr">{othersText}</bdi> here.
						</Trans>
					</span>
				) : null}
				<SaveStatus state={saveState} onRetry={onRetry} />
			</div>

			{editable ? (
				<div className="flex flex-col gap-2 md:items-end">
					{choices.length > 1 ? (
						<ToggleGroup
							aria-label={t`Unit for ${name}`}
							variant="segmented"
							value={[activeUnit]}
							onValueChange={(next) => {
								if (next[0]) onActiveUnit(next[0] as UnitRef)
							}}
							className="flex-wrap"
						>
							{choices.map((choice) => (
								<ToggleGroupItem
									key={choice}
									value={choice}
									className="h-11 min-w-11 md:h-7"
									data-testid={`count-unit-${row.key}-${choice}`}
								>
									<bdi dir="ltr">{quantity.unitName(choice, row.units)}</bdi>
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					) : null}
					<div
						onBlur={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget as Node)) {
								onCommit(activeUnit)
							}
						}}
					>
						<QuantityStepper
							value={value}
							onValueChange={(next) => onChange(activeUnit, next)}
							step={entryStep(activeUnit)}
							fractions={showFractions}
							placeholder="0"
							decrementLabel={t`Less`}
							incrementLabel={t`More`}
							fractionLabel={(fraction) => t`Add ${fraction}`}
							aria-label={t`${name}, amount in ${unitName}`}
							data-testid={`count-input-${row.key}`}
						/>
					</div>
					{typedElsewhere.length > 0 ? (
						<span
							className="text-muted-foreground text-xs"
							data-testid="count-row-other-units"
						>
							<Trans>Also counted:</Trans>{' '}
							{typedElsewhere.map(([unit, amount], index) => (
								<span key={unit}>
									{index > 0 ? ' + ' : ''}
									<bdi dir="ltr">
										{new Intl.NumberFormat(quantity.locale, {
											maximumFractionDigits: 3,
										}).format(amount as number)}{' '}
										{quantity.unitName(unit as UnitRef, row.units)}
									</bdi>
								</span>
							))}
						</span>
					) : null}
				</div>
			) : (
				<span
					className="text-sm tabular-nums"
					data-testid="count-row-readonly-quantity"
				>
					{row.quantity === null ? (
						<span className="text-muted-foreground">—</span>
					) : (
						<bdi dir="ltr">
							{quantity.format(row.quantity, {
								baseUnit: row.baseUnit,
								countUnit: row.countUnit,
								units: row.units,
							})}
						</bdi>
					)}
				</span>
			)}
		</li>
	)
}
