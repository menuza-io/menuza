import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Icon, type IconName } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Link } from 'react-router'
import {
	type SocialPlatform,
	type SocialPostStatus,
} from '#app/utils/social/platforms.ts'
import { dayKey, monthGrid } from '#app/utils/social/time.ts'
import {
	SOCIAL_PLATFORM_LABELS,
	SOCIAL_POST_STATUS_LABELS,
} from './social-labels.ts'
import { SocialPlatformIcon, SocialPostStatusBadge } from './social-ui.tsx'

export type CalendarPost = {
	id: string
	body: string
	status: SocialPostStatus
	/** When it went out, or when it is scheduled (ISO). */
	at: string | null
	platforms: SocialPlatform[]
	accounts: string[]
	imageUrl: string | null
}

// Each status has its own shape as well as its colour, so it never depends on
// telling colours apart.
const STATUS_ICON: Record<
	SocialPostStatus,
	{ icon: IconName; className: string }
> = {
	draft: { icon: 'pencil', className: 'text-muted-foreground' },
	scheduled: { icon: 'clock', className: 'text-primary' },
	publishing: {
		icon: 'loader',
		className: 'text-primary motion-safe:animate-spin',
	},
	published: { icon: 'check', className: 'text-success' },
	partial: { icon: 'alert-triangle', className: 'text-warning' },
	failed: { icon: 'circle-x', className: 'text-destructive' },
}

/** How much of a post's text its calendar link name carries. */
const LABEL_TEXT_MAX = 80

function StatusDot({ status }: { status: SocialPostStatus }) {
	const { icon, className } = STATUS_ICON[status]
	return (
		<span aria-hidden className={cn('inline-flex shrink-0', className)}>
			<Icon name={icon} className="size-3" />
		</span>
	)
}

export function SocialStatusLegend() {
	const { _ } = useLingui()
	return (
		<ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
			{(Object.keys(STATUS_ICON) as SocialPostStatus[]).map((status) => (
				<li key={status} className="flex items-center gap-1.5">
					<StatusDot status={status} />
					{_(SOCIAL_POST_STATUS_LABELS[status])}
				</li>
			))}
		</ul>
	)
}

export function SocialCalendar({
	month,
	today,
	posts,
	timeZone,
	orgSlug,
	canWrite,
}: {
	month: string
	today: string
	posts: CalendarPost[]
	timeZone: string
	orgSlug: string
	canWrite: boolean
}) {
	const { _, i18n } = useLingui()
	const days = monthGrid(month)
	const byDay = new Map<string, CalendarPost[]>()
	for (const post of posts) {
		if (!post.at) continue
		const key = dayKey(new Date(post.at), timeZone)
		byDay.set(key, [...(byDay.get(key) ?? []), post])
	}
	const weekday = new Intl.DateTimeFormat(i18n.locale, {
		weekday: 'short',
		timeZone: 'UTC',
	})
	const longDay = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'full',
		timeZone: 'UTC',
	})
	const time = new Intl.DateTimeFormat(i18n.locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	})
	function postLabel(post: CalendarPost) {
		const status = _(SOCIAL_POST_STATUS_LABELS[post.status])
		const platforms = post.platforms
			.map((platform) => _(SOCIAL_PLATFORM_LABELS[platform]))
			.join(', ')
		// The full text stays in the link's title; the name keeps it short.
		const body = post.body.trim()
		const text = !body
			? _(msg`Image post`)
			: body.length > LABEL_TEXT_MAX
				? `${body.slice(0, LABEL_TEXT_MAX).trimEnd()}…`
				: body
		if (!post.at) return _(msg`${status}, ${platforms}: ${text}`)
		const at = time.format(new Date(post.at))
		return _(msg`${status}, ${at}, ${platforms}: ${text}`)
	}

	return (
		<div className="border-border overflow-hidden rounded-lg border">
			<div className="bg-muted/50 border-border grid grid-cols-7 border-b">
				{days.slice(0, 7).map((day) => (
					<div
						key={day}
						className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
					>
						{weekday.format(new Date(`${day}T00:00:00Z`))}
					</div>
				))}
			</div>
			<ol className="grid grid-cols-7">
				{days.map((day, index) => {
					const inMonth = day.startsWith(month)
					const dayPosts = (byDay.get(day) ?? []).sort((a, b) =>
						(a.at ?? '').localeCompare(b.at ?? ''),
					)
					const label = longDay.format(new Date(`${day}T00:00:00Z`))
					return (
						<li
							key={day}
							aria-label={label}
							className={cn(
								'group border-border relative min-h-20 border-e border-b p-1 sm:min-h-28 sm:p-1.5',
								index % 7 === 6 && 'border-e-0',
								index >= 35 && 'border-b-0',
								!inMonth && 'bg-muted/30',
							)}
						>
							<div className="flex items-center justify-between gap-1">
								<span
									className={cn(
										'grid size-6 place-items-center rounded-full text-xs tabular-nums',
										!inMonth && 'text-muted-foreground',
										day === today && 'bg-primary text-primary-foreground',
									)}
								>
									{Number(day.slice(8))}
								</span>
								{canWrite && day >= today ? (
									<Link
										to={`/${orgSlug}/marketing/social/new?date=${day}`}
										className="text-muted-foreground hover:text-foreground focus-visible:text-foreground rounded p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
										aria-label={_(msg`New post on ${label}`)}
									>
										<Icon name="plus" className="size-3.5" />
									</Link>
								) : null}
							</div>
							<ul className="mt-1 space-y-0.5">
								{dayPosts.map((post) => (
									<li key={post.id}>
										<Link
											to={`/${orgSlug}/marketing/social/${post.id}`}
											className="hover:bg-muted flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs"
											title={post.body}
											// The time and text are hidden on small screens, so the
											// name carries them at every width.
											aria-label={postLabel(post)}
										>
											<StatusDot status={post.status} />
											{post.at ? (
												<time
													dateTime={post.at}
													className="hidden tabular-nums md:inline"
												>
													{time.format(new Date(post.at))}
												</time>
											) : null}
											<span className="flex shrink-0 gap-0.5">
												{post.platforms.map((platform) => (
													<SocialPlatformIcon
														key={platform}
														platform={platform}
														className="size-3"
													/>
												))}
											</span>
											<span className="hidden truncate lg:inline">
												{post.body || _(msg`Image post`)}
											</span>
										</Link>
									</li>
								))}
							</ul>
						</li>
					)
				})}
			</ol>
		</div>
	)
}

export function SocialPostList({
	posts,
	timeZone,
	orgSlug,
	empty,
}: {
	posts: CalendarPost[]
	timeZone: string
	orgSlug: string
	empty: string
}) {
	const { _, i18n } = useLingui()
	const when = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone,
	})
	if (posts.length === 0) {
		return <p className="text-muted-foreground py-6 text-sm">{empty}</p>
	}
	return (
		<ItemGroup>
			{posts.map((post) => (
				<Item
					key={post.id}
					variant="outline"
					size="sm"
					render={<Link to={`/${orgSlug}/marketing/social/${post.id}`} />}
				>
					{post.imageUrl ? (
						<ItemMedia variant="image">
							<img src={post.imageUrl} alt="" />
						</ItemMedia>
					) : null}
					<ItemContent>
						<ItemTitle className="line-clamp-1 wrap-anywhere">
							{post.body || _(msg`Image post`)}
						</ItemTitle>
						<ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
							{post.at ? (
								<time dateTime={post.at}>{when.format(new Date(post.at))}</time>
							) : (
								<span>{_(msg`No date`)}</span>
							)}
							{post.platforms.length > 0 ? (
								<span className="flex items-center gap-1">
									{post.platforms.map((platform) => (
										<SocialPlatformIcon
											key={platform}
											platform={platform}
											className="size-3.5"
										/>
									))}
									<span className="wrap-anywhere">
										{post.accounts.join(', ')}
									</span>
								</span>
							) : null}
						</ItemDescription>
					</ItemContent>
					<ItemActions>
						<SocialPostStatusBadge status={post.status} />
					</ItemActions>
				</Item>
			))}
		</ItemGroup>
	)
}
