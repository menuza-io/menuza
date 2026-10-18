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
import { PaymentBadge } from '#app/components/reservations/payment-badge.tsx'
import {
	reservationStatusStyle,
	StatusLabel,
} from '#app/components/reservations/status-style.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import {
	canMarkRunningLate,
	HOST_ACTION_LABELS,
	type HostAction,
	hostActionsFor,
} from '#app/utils/reservations/host-actions.ts'
import {
	CHANNEL_LABELS,
	DIETARY_LABELS,
	enumLabel,
	OCCASION_LABELS,
	VIP_TIER_LABELS,
} from '#app/utils/reservations/labels.ts'

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
 * One party on the host board: name, size, time, table, ONE primary action
 * and everything else in the menu. At most two badges; notes are one muted line.
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
	const vip =
		rsv.guest?.vipTier && rsv.guest.vipTier !== 'none'
			? enumLabel(tx, VIP_TIER_LABELS, rsv.guest.vipTier)
			: null

	// Badge 1: the one thing that needs attention. Badge 2: payment, else VIP.
	const attention = unassigned
		? { variant: 'destructive' as const, label: t`Unassigned` }
		: rsv.lateRisk
			? { variant: 'warning' as const, label: t`Late risk` }
			: lateMin
				? { variant: 'warning' as const, label: t`+${lateMin}m late` }
				: null

	const noteBits = [
		rsv.occasion ? enumLabel(tx, OCCASION_LABELS, rsv.occasion) : null,
		...rsv.dietaryCodes.map((c) => enumLabel(tx, DIETARY_LABELS, c)),
		rsv.guestNotes,
	].filter(Boolean)

	const showMenu = canManage && (secondary.length > 0 || kind !== 'finished')
	const rowTestId = `today-${kind === 'upcoming' ? 'upcoming' : kind}-card-${rsv.id}`
	const elapsed = elapsedMin
	const planned = rsv.durationMin

	return (
		<div
			className={cn(
				'bg-background flex min-w-0 flex-col gap-1.5 rounded-lg border p-3',
				kind === 'finished' && 'bg-muted/20',
			)}
			data-testid={rowTestId}
		>
			<div className="flex min-w-0 items-start justify-between gap-2">
				<Button
					type="button"
					variant="link"
					className={cn(
						'h-auto min-h-11 min-w-0 justify-start p-0 text-start text-sm font-semibold whitespace-normal md:min-h-8',
						style.strike && 'line-through',
					)}
					onClick={() => onOpenDetail(rsv.id)}
					data-testid={`today-open-detail-${rsv.id}`}
				>
					<span className="wrap-anywhere">
						{kind === 'seated' && tableLabels
							? `${tableLabels} · `
							: `${rsv.hhmm} · `}
						{guest} ({size})
					</span>
				</Button>
			</div>

			{canManage && (primary?.to || showMenu) ? (
				<div
					className="flex min-w-0 flex-wrap items-center justify-end gap-1"
					data-testid={`today-actions-${rsv.id}`}
				>
					{primary && primary.to ? (
						<Button
							type="button"
							size="sm"
							variant={primary.action === 'seat' ? 'default' : 'outline'}
							className="h-11 max-w-full min-w-0 md:h-8"
							disabled={busy}
							onClick={() => onAction(rsv, primary)}
							data-testid={`${ACTION_TEST_ID[primary.action] ?? 'today-action'}-${rsv.id}`}
						>
							{primary.action === 'seat' || primary.action === 'finish' ? (
								<Icon name="check" className="size-3.5" />
							) : null}
							{tx(HOST_ACTION_LABELS[primary.action])}
						</Button>
					) : null}
					{showMenu ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										type="button"
										size="icon"
										variant="ghost"
										className="size-11 md:size-8"
										aria-label={t`More actions for ${guest}`}
										disabled={busy}
										data-testid={`today-menu-${rsv.id}`}
									>
										<Icon name="more-horizontal" className="size-4" />
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

			<div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
				<StatusLabel status={rsv.status} />
				{kind === 'seated' ? (
					<span
						className={cn('tabular-nums', overTurn && 'text-warning')}
						data-testid={`today-elapsed-${rsv.id}`}
					>
						{t`${elapsed}m / ${planned}m`}
					</span>
				) : tableLabels ? (
					<span>{tableLabels}</span>
				) : null}
				{kind === 'seated' && rsv.serverLabel ? (
					<span>{rsv.serverLabel}</span>
				) : null}
				{rsv.channel ? (
					<span data-testid={`today-channel-${rsv.id}`}>
						{enumLabel(tx, CHANNEL_LABELS, rsv.channel)}
					</span>
				) : null}
			</div>

			{attention || vip || rsv.paymentStatus !== 'none' ? (
				<div className="flex flex-wrap items-center gap-1">
					{attention ? (
						<Badge variant={attention.variant}>{attention.label}</Badge>
					) : null}
					<PaymentBadge
						paymentStatus={rsv.paymentStatus}
						experience={Boolean(rsv.experienceId)}
					/>
					{vip && !attention && rsv.paymentStatus === 'none' ? (
						<Badge variant="default">{vip}</Badge>
					) : null}
				</div>
			) : null}

			{kind !== 'finished' && noteBits.length > 0 ? (
				<p className="text-muted-foreground flex items-center gap-1.5 text-xs">
					<Icon name="info" className="size-3.5 shrink-0" />
					<span className="truncate">{noteBits.join(' · ')}</span>
				</p>
			) : null}
		</div>
	)
}
