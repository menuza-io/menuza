import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	TouchSensor,
	useSensor,
	useSensors,
	type Announcements,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trans, useLingui } from '@lingui/react/macro'
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
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { type ReactNode, useMemo, useState } from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { StatusLabel } from '#app/components/reservations/status-style.tsx'
import {
	useFormatMinutes,
	useTick,
	WaitlistCountdown,
} from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { CHANNEL_LABELS, enumLabel } from '#app/utils/reservations/labels.ts'
import {
	type WaitlistEntry,
	type WaitlistStatusTarget,
} from '#app/utils/reservations/waitlist-api.ts'
import {
	availableActions,
	isQuoteExceeded,
	minutesSince,
	moveWithin,
	needsConfirmation,
	reorderByStep,
	WAITLIST_STATUS_ACTION_LABELS,
	waitlistChannelKey,
} from '#app/utils/reservations/waitlist-view.ts'

export type WaitlistQueueHandlers = {
	onNotify: (entry: WaitlistEntry) => void
	onSeat: (entry: WaitlistEntry) => void
	onEdit: (entry: WaitlistEntry) => void
	onStatus: (entry: WaitlistEntry, status: WaitlistStatusTarget) => void
	onReorder: (ids: string[], movedId: string) => void
}

type CardProps = WaitlistQueueHandlers & {
	entry: WaitlistEntry
	index: number
	total: number
	canManage: boolean
	busy: boolean
	reordering: boolean
	nowMs: number
	clockOffsetMs: number
	areaName: string | null
	ids: readonly string[]
	handle?: ReactNode
}

const TOUCH_BUTTON = 'h-11 md:h-8'

function WaitlistRow({
	entry,
	index,
	total,
	canManage,
	busy,
	reordering,
	nowMs,
	clockOffsetMs,
	areaName,
	ids,
	handle,
	onNotify,
	onSeat,
	onEdit,
	onStatus,
	onReorder,
}: CardProps) {
	const { t, i18n } = useLingui()
	const formatMinutes = useFormatMinutes()
	const [confirming, setConfirming] = useState<WaitlistStatusTarget | null>(
		null,
	)
	const actions = availableActions(entry.status, canManage)
	const waited = minutesSince(entry.joinedAt, nowMs)
	const exceeded = isQuoteExceeded(entry, nowMs)
	const up = reorderByStep(ids, entry.id, -1)
	const down = reorderByStep(ids, entry.id, 1)
	const guest = entry.displayName
	const position = index + 1
	const waitedText = formatMinutes(waited)
	const quotedText =
		entry.quotedMin === null ? null : formatMinutes(entry.quotedMin)
	const channel = waitlistChannelKey(entry)
	const channelText =
		channel === 'online'
			? enumLabel((d) => i18n._(d), CHANNEL_LABELS, channel)
			: null

	// One primary action per party: tell a waiting party their table is ready,
	// seat a party that has already been told. Everything else lives in the menu.
	const primary: 'notify' | 'seat' | null = !canManage
		? null
		: entry.status === 'waiting' && actions.notify
			? 'notify'
			: actions.seat
				? 'seat'
				: null
	const hasMenu =
		canManage &&
		(actions.edit ||
			actions.statuses.length > 0 ||
			actions.reorder ||
			(actions.notify && primary !== 'notify') ||
			(actions.seat && primary !== 'seat'))

	return (
		<div
			className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:gap-4"
			data-testid={`waitlist-card-${entry.id}`}
			data-status={entry.status}
		>
			<div className="flex min-w-0 flex-1 items-start gap-2">
				{handle}
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						{entry.position ? (
							<span
								className="text-muted-foreground text-xs tabular-nums"
								data-testid={`waitlist-position-${entry.id}`}
							>
								#{entry.position}
							</span>
						) : null}
						<span className="font-medium wrap-anywhere">
							{guest}{' '}
							<span className="text-muted-foreground font-normal">
								({entry.partySize})
							</span>
						</span>
						<StatusLabel
							kind="waitlist"
							status={entry.status}
							testId={`waitlist-status-${entry.id}`}
						/>
						<WaitlistCountdown entry={entry} offsetMs={clockOffsetMs} />
					</div>
					<div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
						{entry.status === 'waiting' ||
						entry.status === 'notified' ||
						entry.status === 'on_the_way' ? (
							<span data-testid={`waitlist-waited-${entry.id}`}>
								<Trans>Waiting {waitedText}</Trans>
							</span>
						) : null}
						{areaName ? <span>{areaName}</span> : null}
						{channelText ? <span>{channelText}</span> : null}
						{entry.phone ? (
							<span dir="ltr" className="font-mono">
								{entry.phone}
							</span>
						) : null}
					</div>
					{entry.notes ? (
						<p className="text-muted-foreground mt-0.5 text-xs wrap-anywhere">
							{entry.notes}
						</p>
					) : null}
				</div>
			</div>

			<div className="flex items-center justify-between gap-3 sm:justify-end">
				<div
					className="flex min-w-16 flex-col sm:items-end"
					data-testid={`waitlist-quote-${entry.id}`}
				>
					<span
						className={cn(
							'text-lg leading-none font-semibold tabular-nums',
							exceeded && 'text-destructive',
							!quotedText && 'text-muted-foreground',
						)}
					>
						{quotedText ?? '-'}
					</span>
					<span className="text-muted-foreground text-2xs mt-1">
						{quotedText ? <Trans>quoted</Trans> : <Trans>No quote</Trans>}
					</span>
					{exceeded ? (
						<span
							className="text-destructive text-2xs"
							data-testid={`waitlist-over-quote-${entry.id}`}
						>
							<Trans>Over quote</Trans>
						</span>
					) : null}
				</div>

				{canManage ? (
					<div className="flex items-center gap-1.5">
						{primary === 'notify' ? (
							<Button
								type="button"
								className={TOUCH_BUTTON}
								disabled={busy}
								onClick={() => onNotify(entry)}
								data-testid={`waitlist-notify-${entry.id}`}
							>
								<Icon name="send" />
								<Trans>Notify</Trans>
							</Button>
						) : null}
						{primary === 'seat' ? (
							<Button
								type="button"
								className={TOUCH_BUTTON}
								disabled={busy}
								onClick={() => onSeat(entry)}
								data-testid={`waitlist-seat-${entry.id}`}
							>
								<Icon name="check" />
								<Trans>Seat</Trans>
							</Button>
						) : null}
						{hasMenu ? (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-11 md:size-8"
											disabled={busy}
											aria-label={t`More actions for ${guest}`}
											data-testid={`waitlist-more-${entry.id}`}
										/>
									}
								>
									<Icon name="ellipsis" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{actions.notify && primary !== 'notify' ? (
										<DropdownMenuItem
											onClick={() => onNotify(entry)}
											data-testid={`waitlist-notify-${entry.id}`}
										>
											{entry.status === 'on_the_way' ? (
												<Trans>Notify again</Trans>
											) : (
												<Trans>Notify</Trans>
											)}
										</DropdownMenuItem>
									) : null}
									{actions.seat && primary !== 'seat' ? (
										<DropdownMenuItem
											onClick={() => onSeat(entry)}
											data-testid={`waitlist-seat-${entry.id}`}
										>
											<Trans>Seat now</Trans>
										</DropdownMenuItem>
									) : null}
									{actions.edit ? (
										<DropdownMenuItem
											onClick={() => onEdit(entry)}
											data-testid={`waitlist-edit-${entry.id}`}
										>
											<Trans>Edit party</Trans>
										</DropdownMenuItem>
									) : null}
									{actions.reorder ? (
										<>
											<DropdownMenuItem
												disabled={!up || reordering}
												onClick={() => up && onReorder(up, entry.id)}
												data-testid={`waitlist-move-up-${entry.id}`}
											>
												<Trans>Move up</Trans>
											</DropdownMenuItem>
											<DropdownMenuItem
												disabled={!down || reordering}
												onClick={() => down && onReorder(down, entry.id)}
												data-testid={`waitlist-move-down-${entry.id}`}
											>
												<Trans>Move down</Trans>
											</DropdownMenuItem>
										</>
									) : null}
									{actions.statuses.length > 0 ? (
										<DropdownMenuSeparator />
									) : null}
									{actions.statuses.map((status) => (
										<DropdownMenuItem
											key={status}
											variant={
												status === 'cancelled' || status === 'no_response'
													? 'destructive'
													: undefined
											}
											onClick={() =>
												needsConfirmation(status)
													? setConfirming(status)
													: onStatus(entry, status)
											}
											data-testid={`waitlist-action-${status}-${entry.id}`}
										>
											{enumLabel(
												(d) => i18n._(d),
												WAITLIST_STATUS_ACTION_LABELS,
												status,
											)}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
					</div>
				) : null}
			</div>
			<span className="sr-only">
				<Trans>
					Position {position} of {total}
				</Trans>
			</span>

			<AlertDialog
				open={confirming !== null}
				onOpenChange={(open) => {
					if (!open) setConfirming(null)
				}}
			>
				<AlertDialogContent data-testid={`waitlist-confirm-${entry.id}`}>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Remove {guest} from the waitlist?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								They leave the queue and everyone behind them moves up. This
								cannot be undone.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy}
							onClick={() => {
								if (confirming) onStatus(entry, confirming)
								setConfirming(null)
							}}
							data-testid={`waitlist-confirm-yes-${entry.id}`}
						>
							<Trans>Yes, remove</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

function SortableWaitlistRow(props: CardProps) {
	const { t } = useLingui()
	const { entry } = props
	const guest = entry.displayName
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: entry.id })
	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				'bg-card',
				isDragging && 'shadow-raised relative z-10 opacity-90',
			)}
		>
			<WaitlistRow
				{...props}
				handle={
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						ref={setActivatorNodeRef}
						className="text-muted-foreground mt-1 cursor-grab touch-none active:cursor-grabbing"
						aria-label={t`Reorder ${guest}`}
						data-testid={`waitlist-drag-handle-${entry.id}`}
						{...attributes}
						{...listeners}
					>
						<Icon name="grip-vertical" />
					</Button>
				}
			/>
		</li>
	)
}

export function WaitlistQueue({
	active,
	settled,
	canManage,
	busyId,
	reordering,
	clockOffsetMs,
	areaName,
	onDraggingChange,
	onAdd,
	...handlers
}: WaitlistQueueHandlers & {
	/** Shown in the empty state when the member may add parties. */
	onAdd?: () => void
	active: readonly WaitlistEntry[]
	settled: readonly WaitlistEntry[]
	canManage: boolean
	busyId: string | null
	reordering: boolean
	clockOffsetMs: number
	areaName: (id: string | null) => string | null
	onDraggingChange: (dragging: boolean) => void
}) {
	const { t } = useLingui()
	const nowMs = useTick(15_000, clockOffsetMs)
	const ids = useMemo(() => active.map((entry) => entry.id), [active])
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 220, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)

	const announcements: Announcements = useMemo(() => {
		const nameOf = (id: unknown) =>
			active.find((entry) => entry.id === id)?.displayName ?? ''
		const placeOf = (id: unknown) => {
			const index = ids.indexOf(String(id))
			return index < 0 ? 0 : index + 1
		}
		const total = ids.length
		return {
			onDragStart({ active: a }) {
				const name = nameOf(a.id)
				const place = placeOf(a.id)
				return t`Picked up ${name}, position ${place} of ${total}.`
			},
			onDragOver({ active: a, over }) {
				if (!over) return undefined
				const name = nameOf(a.id)
				const place = placeOf(over.id)
				return t`${name} is over position ${place} of ${total}.`
			},
			onDragEnd({ active: a, over }) {
				const name = nameOf(a.id)
				if (!over) return t`${name} was dropped. The order did not change.`
				const place = placeOf(over.id)
				return t`${name} dropped at position ${place} of ${total}.`
			},
			onDragCancel({ active: a }) {
				const name = nameOf(a.id)
				return t`Reorder cancelled. ${name} stays where they were.`
			},
		}
	}, [active, ids, t])

	const handleDragEnd = (event: DragEndEvent) => {
		onDraggingChange(false)
		const overId = event.over?.id
		if (!overId || overId === event.active.id) return
		const toIndex = ids.indexOf(String(overId))
		if (toIndex < 0) return
		handlers.onReorder(
			moveWithin(ids, String(event.active.id), toIndex),
			String(event.active.id),
		)
	}

	const cardProps = (entry: WaitlistEntry, index: number): CardProps => ({
		...handlers,
		entry,
		index,
		total: active.length,
		canManage,
		busy: busyId === entry.id,
		reordering,
		nowMs,
		clockOffsetMs,
		areaName: areaName(entry.areaPrefId),
		ids,
	})

	const emptyState = (
		<div data-testid="waitlist-empty">
			<EmptyState
				icons={['users', 'clock', 'user-plus']}
				title={<Trans>Nobody is waiting right now</Trans>}
				description={
					<Trans>Parties you add appear here in the order they arrived.</Trans>
				}
			>
				{onAdd ? (
					<Button type="button" onClick={onAdd}>
						<Icon name="user-plus" />
						<Trans>Add party</Trans>
					</Button>
				) : null}
			</EmptyState>
		</div>
	)

	return (
		<div className="flex flex-col gap-6">
			{active.length === 0 ? (
				emptyState
			) : canManage ? (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					modifiers={[restrictToVerticalAxis]}
					onDragStart={() => onDraggingChange(true)}
					onDragEnd={handleDragEnd}
					onDragCancel={() => onDraggingChange(false)}
					accessibility={{
						announcements,
						screenReaderInstructions: {
							draggable: t`To reorder this party, press Space to pick it up, use the up and down arrow keys to move it, then press Space to drop. Press Escape to cancel. You can also use Move up and Move down in the party menu.`,
						},
						restoreFocus: true,
					}}
				>
					<SortableContext items={ids} strategy={verticalListSortingStrategy}>
						<Frame>
							<ol
								className="divide-border flex flex-col divide-y"
								data-testid="waitlist-queue"
								aria-label={t`Waitlist queue`}
							>
								{active.map((entry, index) => (
									<SortableWaitlistRow
										key={entry.id}
										{...cardProps(entry, index)}
									/>
								))}
							</ol>
						</Frame>
					</SortableContext>
				</DndContext>
			) : (
				<Frame>
					<ol
						className="divide-border flex flex-col divide-y"
						data-testid="waitlist-queue"
						aria-label={t`Waitlist queue`}
					>
						{active.map((entry, index) => (
							<li key={entry.id}>
								<WaitlistRow {...cardProps(entry, index)} />
							</li>
						))}
					</ol>
				</Frame>
			)}

			{settled.length > 0 ? (
				<section className="flex flex-col gap-2" data-testid="waitlist-settled">
					<h2 className="text-muted-foreground text-xs font-medium">
						<Trans>Earlier today</Trans>
					</h2>
					<Frame>
						<ul className="divide-border flex flex-col divide-y">
							{settled.map((entry, index) => (
								<li key={entry.id}>
									<SettledRow {...cardProps(entry, index)} />
								</li>
							))}
						</ul>
					</Frame>
				</section>
			) : null}
		</div>
	)
}

function SettledRow({
	entry,
	canManage,
	busy,
	onStatus,
}: Pick<CardProps, 'entry' | 'canManage' | 'busy' | 'onStatus'>) {
	const actions = availableActions(entry.status, canManage)
	return (
		<div
			className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm"
			data-testid={`waitlist-settled-${entry.id}`}
		>
			<span className="text-muted-foreground wrap-anywhere">
				{entry.displayName} ({entry.partySize})
			</span>
			<span className="flex items-center gap-3">
				<StatusLabel kind="waitlist" status={entry.status} />
				{actions.statuses.includes('waiting') ? (
					<Button
						type="button"
						variant="outline"
						className={TOUCH_BUTTON}
						disabled={busy}
						onClick={() => onStatus(entry, 'waiting')}
						data-testid={`waitlist-action-waiting-${entry.id}`}
					>
						<Trans>Back to waiting</Trans>
					</Button>
				) : null}
			</span>
		</div>
	)
}
