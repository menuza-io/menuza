import { type MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { KanbanCard } from '#app/components/kanban/kanban.tsx'
import {
	deriveGuestFlags,
	GuestFlags,
	hasGuestFlags,
} from '#app/components/reservations/guest-flags.tsx'
import { PaymentBadge } from '#app/components/reservations/payment-badge.tsx'
import { reservationStatusStyle } from '#app/components/reservations/status-style.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { guestsCountLabel } from '#app/utils/reservations/count-labels.ts'
import {
	canMarkRunningLate,
	HOST_ACTION_LABELS,
	type HostAction,
	hostActionsFor,
} from '#app/utils/reservations/host-actions.ts'

export type PartyCardKind = 'upcoming' | 'seated' | 'finished'

export type PartyCardProps = {
	reservation: DayReservationView
	kind: PartyCardKind
	canManage: boolean
	busy: boolean
	/** Whole minutes since the party sat down (seated cards). */
	elapsedMin?: number
	nowMs: number
	onOpenDetail: (reservationId: string) => void
	onAction: (reservation: DayReservationView, action: HostAction) => void
	onRunningLate: (reservation: DayReservationView, minutes: number) => void
}

const ACTION_TEST_ID: Record<string, string> = {
	arrive: 'today-arrive',
	seat: 'today-seat',
	finish: 'today-complete',
}

/**
 * One party on the host board, in the shared kanban card look. Line 1: time (or
 * table when seated) and party size, with the primary action and the menu at
 * the end. Line 2: the guest, a quiet link. One status line. One row of chips.
 * Notes and the booking channel live in the detail sheet.
 */
export function TodayPartyCard({
	reservation: rsv,
	kind,
	canManage,
	busy,
	elapsedMin = 0,
	nowMs,
	onOpenDetail,
	onAction,
	onRunningLate,
}: PartyCardProps) {
	const { t, i18n } = useLingui()
	const tx = (d: MessageDescriptor) => i18n._(d)
	const style = reservationStatusStyle(rsv.status)
	const { primary, secondary } = hostActionsFor(rsv.status, {
		nowMs,
		finishedAtMs: rsv.completedAt,
	})
	const tableLabels = rsv.assignedTableLabels.join(', ')
	const guest = rsv.guestName || t`Guest`
	const size = rsv.partySize
	const overTurn = kind === 'seated' && elapsedMin > rsv.durationMin
	const unassigned = kind === 'upcoming' && rsv.assignedTableLabels.length === 0
	const lateMin = rsv.runningLateMin
	const elapsed = elapsedMin
	const planned = rsv.durationMin

	// The one thing that needs attention, as a chip beside the guest flags.
	const attention = rsv.lateRisk
		? { variant: 'warning' as const, label: t`Late risk` }
		: lateMin
			? { variant: 'warning' as const, label: t`+${lateMin}m late` }
			: null
	const showPayment = rsv.paymentStatus !== 'none'
	const showFlags = kind !== 'finished' && hasGuestFlags(deriveGuestFlags(rsv))

	const showMenu = canManage && (secondary.length > 0 || kind !== 'finished')
	const rowTestId = `today-${kind === 'upcoming' ? 'upcoming' : kind}-card-${rsv.id}`
	const hasActions = canManage && Boolean(primary?.to || showMenu)
	const statusLabel = tx(style.label)
	const place = kind === 'seated' ? null : tableLabels

	return (
		<KanbanCard testId={rowTestId} muted={kind === 'finished'}>
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
				<span
					className="text-muted-foreground flex min-w-0 items-baseline gap-x-1.5 text-xs"
					data-testid={`today-time-${rsv.id}`}
				>
					<span className="text-foreground font-medium tabular-nums">
						{kind === 'seated' && tableLabels ? tableLabels : rsv.hhmm}
					</span>
					<span aria-hidden="true">·</span>
					<span>{guestsCountLabel(size)}</span>
				</span>
				{hasActions ? (
					<div
						className="-me-1 flex shrink-0 items-center gap-1"
						data-testid={`today-actions-${rsv.id}`}
					>
						{primary && primary.to ? (
							<Button
								type="button"
								size="xs"
								variant={primary.action === 'seat' ? 'default' : 'outline'}
								className="pointer-coarse:h-11 pointer-coarse:px-3"
								disabled={busy}
								onClick={() => onAction(rsv, primary)}
								data-testid={`${ACTION_TEST_ID[primary.action] ?? 'today-action'}-${rsv.id}`}
							>
								{primary.action === 'seat' || primary.action === 'finish' ? (
									<Icon name="check" />
								) : null}
								<span className="truncate">
									{tx(HOST_ACTION_LABELS[primary.action])}
								</span>
							</Button>
						) : null}
						{showMenu ? (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											type="button"
											size="icon-xs"
											variant="ghost"
											className="text-muted-foreground pointer-coarse:size-11"
											aria-label={t`More actions for ${guest}`}
											disabled={busy}
											data-testid={`today-menu-${rsv.id}`}
										>
											<Icon name="more-horizontal" />
										</Button>
									}
								/>
								<DropdownMenuContent align="end">
									{secondary.map((item) => (
										<DropdownMenuItem
											key={item.action}
											onClick={() =>
												item.to ? onAction(rsv, item) : onOpenDetail(rsv.id)
											}
											data-testid={`today-menu-${item.action}-${rsv.id}`}
										>
											{tx(HOST_ACTION_LABELS[item.action])}
										</DropdownMenuItem>
									))}
									{canMarkRunningLate(rsv.status) ? (
										<DropdownMenuItem
											onClick={() => onRunningLate(rsv, 15)}
											data-testid={`today-late-${rsv.id}`}
										>
											{t`Running late: add 15 minutes`}
										</DropdownMenuItem>
									) : null}
									{secondary.length > 0 ? <DropdownMenuSeparator /> : null}
									<DropdownMenuItem onClick={() => onOpenDetail(rsv.id)}>
										{t`Open details`}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
					</div>
				) : null}
			</div>

			<button
				type="button"
				className={cn(
					'text-foreground focus-visible:ring-ring/50 -my-1 block w-full min-w-0 rounded-sm py-1 text-start text-sm font-medium outline-none hover:underline focus-visible:underline focus-visible:ring-3 pointer-coarse:min-h-11',
					style.strike && 'line-through',
				)}
				onClick={() => onOpenDetail(rsv.id)}
				data-testid={`today-open-detail-${rsv.id}`}
			>
				<span className="line-clamp-2 wrap-anywhere" title={guest}>
					{guest}
				</span>
			</button>

			<p
				className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
				data-status-tone={style.tone}
			>
				<span
					aria-hidden="true"
					className={cn('size-1.5 shrink-0 rounded-full', style.dot)}
				/>
				<span className="min-w-0 truncate">
					{unassigned ? (
						<span className="text-destructive">{t`Unassigned`}</span>
					) : place ? (
						place
					) : null}
					{unassigned || place ? ' · ' : null}
					{statusLabel}
					{kind === 'seated' ? (
						<>
							{' '}
							<span
								className={cn('tabular-nums', overTurn && 'text-warning')}
								data-testid={`today-elapsed-${rsv.id}`}
							>
								{t`${elapsed}m / ${planned}m`}
							</span>
							{rsv.serverLabel ? ` · ${rsv.serverLabel}` : null}
						</>
					) : null}
				</span>
			</p>

			{showFlags || attention || showPayment ? (
				<div className="flex min-w-0 flex-wrap items-start gap-1">
					{showFlags ? (
						<GuestFlags reservation={rsv} className="contents" />
					) : null}
					{attention ? (
						<Badge variant={attention.variant}>{attention.label}</Badge>
					) : null}
					<PaymentBadge
						paymentStatus={rsv.paymentStatus}
						experience={Boolean(rsv.experienceId)}
					/>
				</div>
			) : null}
		</KanbanCard>
	)
}
