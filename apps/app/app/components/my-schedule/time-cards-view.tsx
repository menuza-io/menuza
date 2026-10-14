import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { useId, useState } from 'react'
import {
	type MyTimeCard,
	type MyTimeCardEdit,
	type MyTimeCards,
} from '#app/utils/my-schedule/my-schedule-api.ts'
import {
	formatDay,
	formatDelta,
	formatPaid,
	formatRange,
	formatStamp,
	formatTime,
	formatSpan,
} from '#app/utils/my-schedule/my-schedule-format.ts'
import { describeMyScheduleError } from '#app/utils/my-schedule/my-schedule-messages.ts'

/**
 * The person's own recent time cards, with their edit history: what was
 * changed, when, why and how the hours moved. Never pay, tips or notes. If
 * something looks wrong, the page says to talk to a manager.
 */
export function TimeCardsView({
	cards,
	error,
	loading,
	locale,
}: {
	cards: MyTimeCards | null
	error: unknown
	loading: boolean
	locale: string
}) {
	const { _ } = useLingui()
	if (!cards) {
		return error ? (
			<Alert>
				<AlertDescription>{describeMyScheduleError(error, _)}</AlertDescription>
			</Alert>
		) : (
			<div aria-hidden={!loading} className="flex flex-col gap-3">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		)
	}
	const total = cards.cards.reduce((sum, card) => sum + card.paidMinutes, 0)
	const totalLabel = formatPaid(total, locale)
	return (
		<div className="flex flex-col gap-4">
			<p className="text-muted-foreground text-sm">
				<bdi>{formatSpan(cards.from, cards.to, locale)}</bdi>
				{cards.cards.length > 0 ? (
					<>
						{' · '}
						<Trans>
							Paid time <bdi>{totalLabel}</bdi>
						</Trans>
					</>
				) : null}
			</p>
			{cards.cards.length === 0 ? (
				<p className="text-muted-foreground py-8 text-center text-sm">
					<Trans>No time cards in these weeks.</Trans>
				</p>
			) : (
				<ItemGroup className="gap-2">
					{cards.cards.map((card) => (
						<CardRow key={card.id} card={card} locale={locale} />
					))}
				</ItemGroup>
			)}
			<p className="text-muted-foreground text-sm text-balance">
				<Trans>If something looks wrong, talk to your manager.</Trans>
			</p>
		</div>
	)
}

function CardRow({ card, locale }: { card: MyTimeCard; locale: string }) {
	const { _ } = useLingui()
	const [open, setOpen] = useState(false)
	const panel = useId()
	const status =
		card.status === 'open'
			? _(t`Still clocked in`)
			: card.status === 'approved'
				? _(t`Approved`)
				: card.status === 'locked'
					? _(t`Locked`)
					: null
	const expandable = card.edits.length > 0
	const paid = formatPaid(card.paidMinutes, locale)
	const content = (
		<>
			<span className="flex min-w-0 flex-col gap-0.5 text-start">
				<span className="text-sm font-medium">
					{formatDay(card.localDate, locale)}
				</span>
				<span className="text-base tabular-nums">
					<bdi>
						{card.clockOutAt === null
							? formatTime(card.clockInAt, card.timeZone, locale)
							: formatRange(
									card.clockInAt,
									card.clockOutAt,
									card.timeZone,
									locale,
								)}
					</bdi>
				</span>
				<span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
					{card.clockOutAt !== null ? (
						<span>
							<Trans>
								Paid <bdi>{paid}</bdi>
							</Trans>
						</span>
					) : null}
					{status ? <Badge variant="outline">{status}</Badge> : null}
					{card.edited ? (
						<Badge variant="secondary">
							<Trans>Edited</Trans>
						</Badge>
					) : null}
				</span>
			</span>
			{expandable ? (
				<>
					<Icon
						name={open ? 'chevron-up' : 'chevron-down'}
						className="text-muted-foreground mt-1 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span className="sr-only">
						{open ? _(t`Hide changes`) : _(t`Show changes`)}
					</span>
				</>
			) : null}
		</>
	)
	return (
		<Item variant="outline" size="sm" role="listitem">
			<div className="w-full">
				{expandable ? (
					<Collapsible open={open} onOpenChange={setOpen}>
						<CollapsibleTrigger
							render={
								<Button
									size="sm"
									type="button"
									variant="ghost"
									className="h-auto min-h-11 w-full items-start justify-between gap-3 p-0 text-start font-normal"
								/>
							}
						>
							{content}
						</CollapsibleTrigger>
						<CollapsibleContent>
							<ol
								id={panel}
								className="border-border mt-3 flex flex-col gap-3 border-t pt-3"
							>
								{card.edits.map((edit) => (
									<EditItem
										key={edit.id}
										edit={edit}
										timeZone={card.timeZone}
										locale={locale}
									/>
								))}
							</ol>
						</CollapsibleContent>
					</Collapsible>
				) : (
					<div className="flex items-start justify-between gap-3">
						{content}
					</div>
				)}
			</div>
		</Item>
	)
}

function EditItem({
	edit,
	timeZone,
	locale,
}: {
	edit: MyTimeCardEdit
	timeZone: string
	locale: string
}) {
	const { _ } = useLingui()
	const delta =
		edit.hoursDeltaMinutes === null ? '' : formatDelta(edit.hoursDeltaMinutes)
	const what =
		edit.action === 'create'
			? _(t`A manager added this time card.`)
			: edit.action === 'void'
				? _(t`A manager removed this time card.`)
				: edit.action === 'auto_clock_out'
					? _(t`You were clocked out automatically.`)
					: edit.action === 'approve'
						? _(t`A manager approved this time card.`)
						: edit.action === 'lock'
							? _(t`A manager locked this time card.`)
							: edit.action === 'unlock'
								? _(t`A manager unlocked this time card.`)
								: _(t`A manager changed this time card.`)
	const reason = edit.reason
	const moved: string[] = []
	if (
		edit.before &&
		edit.after &&
		edit.before.clockInAt !== edit.after.clockInAt &&
		edit.after.clockInAt !== null
	) {
		const from =
			edit.before.clockInAt === null
				? '–'
				: formatTime(edit.before.clockInAt, timeZone, locale)
		const to = formatTime(edit.after.clockInAt, timeZone, locale)
		moved.push(_(t`Clock in ${from} to ${to}`))
	}
	if (
		edit.before &&
		edit.after &&
		edit.before.clockOutAt !== edit.after.clockOutAt &&
		edit.after.clockOutAt !== null
	) {
		const from =
			edit.before.clockOutAt === null
				? '–'
				: formatTime(edit.before.clockOutAt, timeZone, locale)
		const to = formatTime(edit.after.clockOutAt, timeZone, locale)
		moved.push(_(t`Clock out ${from} to ${to}`))
	}
	return (
		<li className="flex flex-col gap-1 text-sm">
			<p className="font-medium">
				{what}{' '}
				<span className="text-muted-foreground font-normal">
					<bdi>{formatStamp(edit.createdAt, timeZone, locale)}</bdi>
				</span>
			</p>
			{edit.reason ? (
				<p className="text-pretty">
					<Trans>Reason: {reason}</Trans>
				</p>
			) : null}
			{moved.map((line) => (
				<p key={line} className="text-muted-foreground tabular-nums">
					<bdi>{line}</bdi>
				</p>
			))}
			{edit.hoursDeltaMinutes !== null && edit.hoursDeltaMinutes !== 0 ? (
				<p className="text-muted-foreground tabular-nums">
					<Trans>
						Hours changed by <bdi>{delta}</bdi>
					</Trans>
				</p>
			) : null}
		</li>
	)
}
