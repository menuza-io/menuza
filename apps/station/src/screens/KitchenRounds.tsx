import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { shortDuration } from '~/lib/duration.ts'
import { type DishStatus } from '~/lib/kitchen-status.ts'
import { useNow } from '~/ui/hooks.ts'
import { cn } from '~/ui/primitives.tsx'

/**
 * Above each round of a tab: when it went to the kitchen and how long ago, or
 * that these items are not sent yet (saving the tab sends them). Times read in
 * the tablet's clock, like every other time on the register.
 */
export function RoundHeading({
	sentAt,
	items,
	timeZone,
	className,
	onRepeat,
	servedAt = null,
	onServed,
}: {
	sentAt: number | null
	items: number
	timeZone?: string
	className?: string
	/** Ring this round again as new items (another round of drinks). */
	onRepeat?: () => void
	/** When every dish of the round was marked brought to the table. */
	servedAt?: number | null
	/** Mark the round brought to the table (offered while some of it is not). */
	onServed?: () => void
}) {
	const { _, i18n } = useLingui()
	const now = useNow()
	if (sentAt === null)
		return (
			<p
				className={cn(
					'text-primary bg-primary/5 flex items-center gap-2 px-4 py-1.5 text-xs font-semibold',
					className,
				)}
			>
				<span aria-hidden className="bg-primary size-1.5 rounded-full" />
				{_(
					plural(items, {
						one: 'Not sent yet · # item',
						other: 'Not sent yet · # items',
					}),
				)}
			</p>
		)
	const time = new Intl.DateTimeFormat(i18n.locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	}).format(sentAt)
	const minutes = Math.max(0, Math.floor((now - sentAt) / 60_000))
	const ago = shortDuration(minutes, i18n.locale)
	const servedTime =
		servedAt === null
			? ''
			: new Intl.DateTimeFormat(i18n.locale, {
					hour: 'numeric',
					minute: '2-digit',
					timeZone,
				}).format(servedAt)
	const actions = Boolean(onRepeat) || (Boolean(onServed) && servedAt === null)
	return (
		<div
			className={cn(
				'text-muted-foreground bg-muted/50 flex items-center gap-2 px-4 text-xs font-medium',
				actions ? 'min-h-11 pe-1' : 'py-1.5',
				className,
			)}
		>
			<Icon name="check" aria-hidden className="text-success size-3.5" />
			<span>
				<Trans>Sent {time}</Trans>
			</span>
			<span aria-hidden>·</span>
			<span className="tnum">
				{minutes === 0 ? _(t`just now`) : _(t`${ago} ago`)}
			</span>
			{servedAt !== null ? (
				<>
					<span aria-hidden>·</span>
					<span className="text-success font-semibold">
						<Trans>Served {servedTime}</Trans>
					</span>
				</>
			) : null}
			{onServed && servedAt === null ? (
				<button
					type="button"
					onClick={onServed}
					className="text-foreground hover:bg-accent ms-auto inline-flex h-11 items-center gap-1.5 rounded-(--station-control-radius) px-3 font-semibold transition-colors"
				>
					<Icon name="check-check" aria-hidden className="size-3.5" />
					<Trans>Mark served</Trans>
				</button>
			) : null}
			{onRepeat ? (
				<button
					type="button"
					onClick={onRepeat}
					className="text-foreground hover:bg-accent ms-auto inline-flex h-11 items-center gap-1.5 rounded-(--station-control-radius) px-3 font-semibold transition-colors"
				>
					<Icon name="copy" aria-hidden className="size-3.5" />
					<Trans>Repeat round</Trans>
				</button>
			) : null}
		</div>
	)
}

/** Where a sent dish is in the kitchen: in the queue, being made, at the pass, or served. */
export function DishStatusBadge({ status }: { status: DishStatus }) {
	const { _ } = useLingui()
	const label = {
		queued: _(t`In queue`),
		preparing: _(t`Preparing`),
		ready: _(t`Ready`),
		served: _(t`Served`),
	}[status]
	return (
		<span className="dish-status" data-status={status}>
			{status === 'served' ? (
				<Icon name="check" aria-hidden className="size-3" />
			) : (
				<span aria-hidden className="dish-status-dot" />
			)}
			{label}
		</span>
	)
}
