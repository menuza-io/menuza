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
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { type ReactNode, useMemo, useState } from 'react'
import { ChannelBadge } from '#app/components/reservations/channel-badge.tsx'
import {
	useFormatMinutes,
	useTick,
	WaitlistCountdown,
} from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { enumLabel } from '#app/utils/reservations/labels.ts'
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
	WAITLIST_STATUS_LABELS,
	waitlistChannelKey,
	waitlistStatusVariant,
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

function WaitlistCard({
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
	const statusLabel = enumLabel(
		(d) => i18n._(d),
		WAITLIST_STATUS_LABELS,
		entry.status,
	)
	const up = reorderByStep(ids, entry.id, -1)
	const down = reorderByStep(ids, entry.id, 1)
	const guest = entry.displayName
	const position = index + 1
	const waitedText = formatMinutes(waited)
	const quotedText =
		entry.quotedMin === null ? null : formatMinutes(entry.quotedMin)

	return (
		<div
			className="bg-background flex flex-col gap-2 rounded-lg border p-3 text-sm"
			data-testid={`waitlist-card-${entry.id}`}
			data-status={entry.status}
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex min-w-0 items-start gap-2">
					{handle}
					{entry.position ? (
						<Badge
							variant="outline"
							data-testid={`waitlist-position-${entry.id}`}
						>
							#{entry.position}
						</Badge>
					) : null}
					<div className="min-w-0">
						<div className="font-semibold wrap-anywhere">
							{guest}{' '}
							<span className="text-muted-foreground font-normal">
								({entry.partySize})
							</span>
						</div>
						<div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
							{entry.status === 'waiting' ||
							entry.status === 'notified' ||
							entry.status === 'on_the_way' ? (
								<span data-testid={`waitlist-waited-${entry.id}`}>
									<Trans>Waiting {waitedText}</Trans>
								</span>
							) : null}
							<span data-testid={`waitlist-quote-${entry.id}`}>
								{quotedText ? (
									<Trans>Quoted {quotedText}</Trans>
								) : (
									<Trans>No quote</Trans>
								)}
							</span>
							{areaName ? <span>{areaName}</span> : null}
							{entry.phone ? (
								<span dir="ltr" className="font-mono">
									{entry.phone}
								</span>
							) : null}
						</div>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-1">
					<WaitlistCountdown entry={entry} offsetMs={clockOffsetMs} />
					{exceeded ? (
						<Badge
							variant="destructive"
							data-testid={`waitlist-over-quote-${entry.id}`}
						>
							<Trans>Over quote</Trans>
						</Badge>
					) : null}
					<ChannelBadge channel={waitlistChannelKey(entry)} />
					<Badge
						variant={waitlistStatusVariant(entry.status)}
						data-testid={`waitlist-status-${entry.id}`}
					>
						{statusLabel}
					</Badge>
				</div>
			</div>

			{entry.notes ? (
				<div className="text-muted-foreground text-xs wrap-anywhere">
					{entry.notes}
				</div>
			) : null}

			{canManage &&
			(actions.notify ||
				actions.seat ||
				actions.edit ||
				actions.statuses.length > 0) ? (
				confirming ? (
					<div
						className="flex flex-wrap items-center gap-1.5"
						data-testid={`waitlist-confirm-${entry.id}`}
					>
						<span className="text-xs">
							<Trans>Remove {guest} from the waitlist?</Trans>
						</span>
						<Button
							type="button"
							size="xs"
							variant="destructive"
							disabled={busy}
							onClick={() => {
								onStatus(entry, confirming)
								setConfirming(null)
							}}
							data-testid={`waitlist-confirm-yes-${entry.id}`}
						>
							<Trans>Yes, remove</Trans>
						</Button>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={() => setConfirming(null)}
						>
							<Trans>Keep</Trans>
						</Button>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-1.5">
						{actions.notify ? (
							<Button
								type="button"
								size="xs"
								variant="outline"
								disabled={busy}
								onClick={() => onNotify(entry)}
								data-testid={`waitlist-notify-${entry.id}`}
							>
								<Icon name="send" className="size-3.5" />
								<span>
									{entry.status === 'on_the_way' ? (
										<Trans>Notify again</Trans>
									) : (
										<Trans>Notify</Trans>
									)}
								</span>
							</Button>
						) : null}
						{actions.seat ? (
							<Button
								type="button"
								size="xs"
								disabled={busy}
								onClick={() => onSeat(entry)}
								data-testid={`waitlist-seat-${entry.id}`}
							>
								<Icon name="check" className="size-3.5" />
								<span>
									<Trans>Seat</Trans>
								</span>
							</Button>
						) : null}
						{actions.edit ? (
							<Button
								type="button"
								size="xs"
								variant="ghost"
								disabled={busy}
								onClick={() => onEdit(entry)}
								data-testid={`waitlist-edit-${entry.id}`}
							>
								<Icon name="pencil" className="size-3.5" />
								<span>
									<Trans>Edit</Trans>
								</span>
							</Button>
						) : null}
						{actions.statuses.map((status) => (
							<Button
								key={status}
								type="button"
								size="xs"
								variant="ghost"
								disabled={busy}
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
							</Button>
						))}
						{actions.reorder ? (
							<span className="ms-auto flex items-center gap-1">
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									disabled={!up || reordering}
									aria-label={t`Move ${guest} up`}
									onClick={() => up && onReorder(up, entry.id)}
									data-testid={`waitlist-move-up-${entry.id}`}
								>
									<Icon name="chevron-up" className="size-3.5" />
								</Button>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									disabled={!down || reordering}
									aria-label={t`Move ${guest} down`}
									onClick={() => down && onReorder(down, entry.id)}
									data-testid={`waitlist-move-down-${entry.id}`}
								>
									<Icon name="chevron-down" className="size-3.5" />
								</Button>
								<span className="sr-only">
									<Trans>
										Position {position} of {total}
									</Trans>
								</span>
							</span>
						) : null}
					</div>
				)
			) : null}
		</div>
	)
}

function SortableWaitlistCard(props: CardProps) {
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
			className={cn(isDragging && 'relative z-10 opacity-80 shadow-md')}
		>
			<WaitlistCard
				{...props}
				handle={
					<button
						type="button"
						ref={setActivatorNodeRef}
						className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-0.5 cursor-grab touch-none rounded p-0.5 focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
						aria-label={t`Reorder ${guest}`}
						data-testid={`waitlist-drag-handle-${entry.id}`}
						{...attributes}
						{...listeners}
					>
						<Icon name="grip-vertical" className="size-4" />
					</button>
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
	...handlers
}: WaitlistQueueHandlers & {
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

	return (
		<div className="flex flex-col gap-4">
			{active.length === 0 ? (
				<div
					className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm"
					data-testid="waitlist-empty"
				>
					<Trans>Nobody is waiting right now.</Trans>
				</div>
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
							draggable: t`To reorder this party, press Space to pick it up, use the up and down arrow keys to move it, then press Space to drop. Press Escape to cancel. You can also use the Move up and Move down buttons.`,
						},
						restoreFocus: true,
					}}
				>
					<SortableContext items={ids} strategy={verticalListSortingStrategy}>
						<ol
							className="flex flex-col gap-2.5"
							data-testid="waitlist-queue"
							aria-label={t`Waitlist queue`}
						>
							{active.map((entry, index) => (
								<SortableWaitlistCard
									key={entry.id}
									{...cardProps(entry, index)}
								/>
							))}
						</ol>
					</SortableContext>
				</DndContext>
			) : (
				<ol
					className="flex flex-col gap-2.5"
					data-testid="waitlist-queue"
					aria-label={t`Waitlist queue`}
				>
					{active.map((entry, index) => (
						<li key={entry.id}>
							<WaitlistCard {...cardProps(entry, index)} />
						</li>
					))}
				</ol>
			)}

			{settled.length > 0 ? (
				<section
					className="flex flex-col gap-2 border-t pt-3"
					data-testid="waitlist-settled"
				>
					<h3 className="text-muted-foreground text-xs font-medium">
						<Trans>Earlier today</Trans>
					</h3>
					<ul className="flex flex-col gap-1.5">
						{settled.map((entry, index) => (
							<li key={entry.id}>
								<SettledRow {...cardProps(entry, index)} />
							</li>
						))}
					</ul>
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
	const { i18n } = useLingui()
	const actions = availableActions(entry.status, canManage)
	return (
		<div
			className="bg-muted/20 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5 text-xs"
			data-testid={`waitlist-settled-${entry.id}`}
		>
			<span className="wrap-anywhere">
				{entry.displayName} ({entry.partySize})
			</span>
			<span className="flex items-center gap-1.5">
				{actions.statuses.includes('waiting') ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						disabled={busy}
						onClick={() => onStatus(entry, 'waiting')}
						data-testid={`waitlist-action-waiting-${entry.id}`}
					>
						<Trans>Back to waiting</Trans>
					</Button>
				) : null}
				<Badge variant={waitlistStatusVariant(entry.status)}>
					{enumLabel((d) => i18n._(d), WAITLIST_STATUS_LABELS, entry.status)}
				</Badge>
			</span>
		</div>
	)
}
