import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { occasionTitle } from '@repo/marketing/occasions'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { Link, useFetcher } from 'react-router'
import { MonthGrid } from '#app/components/social/month-grid.tsx'
import { type CalendarPost } from '#app/components/social/social-calendar.tsx'
import { SocialPlatformIcon } from '#app/components/social/social-ui.tsx'
import {
	type CalendarBroadcast,
	type CalendarOccasion,
} from '#app/utils/marketing/calendar.server.ts'
import { dayKey } from '#app/utils/social/time.ts'

/**
 * The month view of the marketing calendar (#152): scheduled broadcasts, social
 * posts and the market's occasions on one grid (the same month grid the social
 * calendar draws), and the occasions coming up in the next four weeks as cards
 * with a ready-made campaign.
 */

function OccasionStatusNote({ occasion }: { occasion: CalendarOccasion }) {
	const { _ } = useLingui()
	if (occasion.status === 'scheduled') {
		return (
			<span className="text-success text-xs">
				{_(
					msg`Scheduled automatically. You can edit or cancel it until it goes out.`,
				)}
			</span>
		)
	}
	if (occasion.status === 'skipped') {
		return (
			<span className="text-warning text-xs">
				{occasion.skipReason === 'occasion_conflict'
					? _(
							msg`Not scheduled: another broadcast is already scheduled within 2 days of it.`,
						)
					: occasion.skipReason === 'sms_allowance'
						? _(msg`Not scheduled: no text sends are left this month.`)
						: _(msg`Not scheduled automatically this year.`)}
			</span>
		)
	}
	return null
}

export function OccasionCard({
	occasion,
	orgSlug,
	canWrite,
}: {
	occasion: CalendarOccasion
	orgSlug: string
	canWrite: boolean
}) {
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<{ ok?: boolean }>()
	const title = occasionTitle(occasion.key, i18n.locale)
	const longDate = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'full',
		timeZone: 'UTC',
	}).format(new Date(`${occasion.date}T00:00:00Z`))
	const sendOn = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(occasion.sendAt))
	const busy = fetcher.state !== 'idle'
	return (
		<Item variant="outline" data-testid={`occasion-${occasion.key}`}>
			<ItemContent className="min-w-0">
				<ItemTitle className="flex flex-wrap items-center gap-2">
					<span>{title}</span>
					{occasion.expected ? (
						<Badge
							variant="outline"
							title={_(msg`Official dates can move by a day.`)}
						>
							{_(msg`Expected`)}
						</Badge>
					) : null}
				</ItemTitle>
				<ItemDescription className="space-y-1">
					<span className="block">
						{occasion.expected ? _(msg`Expected ${longDate}`) : longDate}
					</span>
					<span className="block">{_(msg`Suggested send: ${sendOn}`)}</span>
					<span
						className="text-foreground/80 block wrap-anywhere"
						data-testid={`occasion-preview-${occasion.key}`}
					>
						{occasion.preview.subject}
					</span>
					<OccasionStatusNote occasion={occasion} />
				</ItemDescription>
			</ItemContent>
			{canWrite ? (
				<ItemActions className="flex flex-wrap items-center justify-end gap-2">
					{occasion.status === 'scheduled' && occasion.campaignId ? (
						<Button
							variant="outline"
							size="sm"
							render={
								<Link
									to={`/${orgSlug}/marketing/campaigns/${occasion.campaignId}`}
								/>
							}
						>
							{_(msg`Open the broadcast`)}
						</Button>
					) : (
						<Button
							size="sm"
							render={
								<Link
									to={`/${orgSlug}/marketing/campaigns/new?occasion=${occasion.key}&date=${occasion.date}`}
								/>
							}
						>
							{_(msg`Use this`)}
						</Button>
					)}
					<Button
						variant="outline"
						size="sm"
						render={
							<Link
								to={`/${orgSlug}/marketing/social/new?occasion=${occasion.key}&date=${occasion.date}`}
							/>
						}
					>
						{_(msg`Social post`)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() =>
							fetcher.submit(
								{
									intent: 'dismiss',
									key: occasion.key,
									year: String(occasion.year),
								},
								{ method: 'post' },
							)
						}
					>
						{_(msg`Dismiss`)}
					</Button>
					<div className="flex items-center gap-2">
						<Label className="flex items-center gap-2 text-sm">
							<Switch
								checked={occasion.autoSchedule}
								disabled={busy}
								aria-label={_(msg`Auto-schedule ${title}`)}
								onCheckedChange={(on) =>
									fetcher.submit(
										{
											intent: 'auto',
											key: occasion.key,
											on: on ? 'true' : 'false',
											channel: occasion.autoChannel,
										},
										{ method: 'post' },
									)
								}
							/>
							{_(msg`Auto-schedule`)}
						</Label>
						<select
							aria-label={_(msg`Channel for ${title}`)}
							className="border-input bg-background h-8 rounded-md border px-2 text-sm"
							value={occasion.autoChannel}
							disabled={busy}
							onChange={(event) =>
								fetcher.submit(
									{
										intent: 'auto',
										key: occasion.key,
										on: occasion.autoSchedule ? 'true' : 'false',
										channel: event.target.value,
									},
									{ method: 'post' },
								)
							}
						>
							<option value="email">{_(msg`Email`)}</option>
							<option value="sms">{_(msg`Text`)}</option>
						</select>
					</div>
				</ItemActions>
			) : null}
		</Item>
	)
}

export function MarketingCalendarGrid({
	month,
	today,
	timeZone,
	orgSlug,
	occasions,
	broadcasts,
	posts,
}: {
	month: string
	today: string
	timeZone: string
	orgSlug: string
	occasions: CalendarOccasion[]
	broadcasts: CalendarBroadcast[]
	posts: CalendarPost[]
}) {
	const { _, i18n } = useLingui()
	const byDay = <T,>(
		items: T[],
		at: (item: T) => string | null,
	): Map<string, T[]> => {
		const map = new Map<string, T[]>()
		for (const item of items) {
			const value = at(item)
			if (!value) continue
			const key = dayKey(new Date(value), timeZone)
			map.set(key, [...(map.get(key) ?? []), item])
		}
		return map
	}
	const postsByDay = byDay(posts, (post) => post.at)
	const broadcastsByDay = byDay(broadcasts, (broadcast) => broadcast.at)
	const occasionsByDay = new Map<string, CalendarOccasion[]>()
	for (const occasion of occasions) {
		occasionsByDay.set(occasion.date, [
			...(occasionsByDay.get(occasion.date) ?? []),
			occasion,
		])
	}
	return (
		<MonthGrid
			month={month}
			today={today}
			renderDay={({ day }) => ({
				content: (
					<ul className="mt-1 space-y-0.5">
						{(occasionsByDay.get(day) ?? []).map((occasion) => {
							const dayTitle = occasionTitle(occasion.key, i18n.locale)
							return (
								<li
									key={occasion.key}
									className="bg-primary/10 text-primary flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs"
									title={
										occasion.expected
											? _(msg`${dayTitle} (expected)`)
											: dayTitle
									}
								>
									<Icon name="sparkles" className="size-3 shrink-0" />
									<span className="truncate">{dayTitle}</span>
								</li>
							)
						})}
						{(broadcastsByDay.get(day) ?? []).map((broadcast) => (
							<li key={broadcast.id}>
								<Link
									to={`/${orgSlug}/marketing/campaigns/${broadcast.id}`}
									className="hover:bg-muted flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs"
									title={broadcast.name}
								>
									<Icon
										name={
											broadcast.channel === 'email' ? 'mail' : 'message-square'
										}
										className="size-3 shrink-0"
									/>
									<span className="truncate">{broadcast.name}</span>
								</Link>
							</li>
						))}
						{(postsByDay.get(day) ?? []).map((post) => (
							<li key={post.id}>
								<Link
									to={`/${orgSlug}/marketing/social/${post.id}`}
									className="hover:bg-muted flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs"
									title={post.body}
								>
									<span className="flex shrink-0 gap-0.5">
										{post.platforms.map((platform) => (
											<SocialPlatformIcon
												key={platform}
												platform={platform}
												className="size-3"
											/>
										))}
									</span>
									<span className="truncate">
										{post.body || _(msg`Image post`)}
									</span>
								</Link>
							</li>
						))}
					</ul>
				),
			})}
		/>
	)
}

export function OccasionList({
	occasions,
	orgSlug,
	canWrite,
}: {
	occasions: CalendarOccasion[]
	orgSlug: string
	canWrite: boolean
}) {
	const { _ } = useLingui()
	if (occasions.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				{_(msg`No occasions in the next four weeks.`)}
			</p>
		)
	}
	return (
		<ItemGroup className="gap-3">
			{occasions.map((occasion) => (
				<OccasionCard
					key={`${occasion.key}-${occasion.date}`}
					occasion={occasion}
					orgSlug={orgSlug}
					canWrite={canWrite}
				/>
			))}
		</ItemGroup>
	)
}
