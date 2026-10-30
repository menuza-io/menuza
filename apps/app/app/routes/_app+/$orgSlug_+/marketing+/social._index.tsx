import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { getHints } from '@repo/ui/client-hints'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import {
	Link,
	useLoaderData,
	useSearchParams,
	type LoaderFunctionArgs,
} from 'react-router'
import {
	SocialCalendar,
	SocialPostList,
	SocialStatusLegend,
} from '#app/components/social/social-calendar.tsx'
import { SOCIAL_PLATFORM_LABELS } from '#app/components/social/social-labels.ts'
import { SocialPlatformIcon } from '#app/components/social/social-ui.tsx'
import { requireSocialAccess } from '#app/utils/social/access.server.ts'
import { listSocialAccounts } from '#app/utils/social/accounts.server.ts'
import {
	SOCIAL_PLATFORMS,
	isSocialPlatform,
} from '#app/utils/social/platforms.ts'
import {
	listSocialPostsBetween,
	listUndatedSocialDrafts,
} from '#app/utils/social/posts.server.ts'
import {
	dayKey,
	isMonthKey,
	monthWindow,
	shiftMonth,
} from '#app/utils/social/time.ts'
import { toCalendarPost } from '#app/utils/social/views.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug)
	const { timeZone } = getHints(request)
	const today = dayKey(new Date(), timeZone)
	const requested = new URL(request.url).searchParams.get('month')
	const month = isMonthKey(requested) ? requested : today.slice(0, 7)
	const { from, to } = monthWindow(month)
	const [posts, drafts, accounts] = await Promise.all([
		listSocialPostsBetween(access.organization.id, from, to),
		listUndatedSocialDrafts(access.organization.id),
		listSocialAccounts(access.organization.id),
	])
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		month,
		today,
		timeZone,
		posts: posts.map(toCalendarPost),
		drafts: drafts.map(toCalendarPost),
		accounts: accounts.map((account) => ({
			platform: account.platform,
			status: account.status,
		})),
	}
}

export default function SocialMediaRoute() {
	const { _, i18n } = useLingui()
	const { orgSlug, canWrite, month, today, timeZone, posts, drafts, accounts } =
		useLoaderData<typeof loader>()
	const [searchParams, setSearchParams] = useSearchParams()
	const view = searchParams.get('view') === 'list' ? 'list' : 'calendar'
	const platformParam = searchParams.get('platform')
	const platform = isSocialPlatform(platformParam) ? platformParam : null

	const visible = platform
		? posts.filter((post) => post.platforms.includes(platform))
		: posts
	const monthPosts = visible
		.filter(
			(post) =>
				post.at && dayKey(new Date(post.at), timeZone).startsWith(month),
		)
		.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
	const visibleDrafts = platform
		? drafts.filter((post) => post.platforms.includes(platform))
		: drafts
	const needsReconnect = accounts.some(
		(account) => account.status === 'needs_reauth',
	)

	const [year, monthNumber] = month.split('-').map(Number) as [number, number]
	const monthLabel = new Intl.DateTimeFormat(i18n.locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(year, monthNumber - 1, 1)))

	const setParam = (key: string, value: string | null) =>
		setSearchParams(
			(current) => {
				const next = new URLSearchParams(current)
				if (value) next.set(key, value)
				else next.delete(key)
				return next
			},
			{ preventScrollReset: true },
		)
	const monthLink = (target: string) => {
		const next = new URLSearchParams(searchParams)
		next.set('month', target)
		return `?${next.toString()}`
	}

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Social media`)}
				description={_(
					msg`Write, schedule and track posts on Facebook and Instagram.`,
				)}
				actions={
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							render={<Link to={`/${orgSlug}/marketing/social/accounts`} />}
						>
							<Icon name="link-2" />
							{_(msg`Accounts`)}
						</Button>
						{canWrite ? (
							<Button render={<Link to={`/${orgSlug}/marketing/social/new`} />}>
								<Icon name="plus" />
								{_(msg`New post`)}
							</Button>
						) : null}
					</div>
				}
			/>

			{accounts.length === 0 ? (
				<Alert>
					<Icon name="link-2" />
					<AlertTitle>{_(msg`Connect your accounts`)}</AlertTitle>
					<AlertDescription>
						<p>
							{_(
								msg`Connect a Facebook Page or an Instagram professional account to start publishing.`,
							)}
						</p>
						<Link
							to={`/${orgSlug}/marketing/social/accounts`}
							className="underline underline-offset-4"
						>
							{_(msg`Connect accounts`)}
						</Link>
					</AlertDescription>
				</Alert>
			) : needsReconnect ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" />
					<AlertTitle>{_(msg`An account needs to be reconnected`)}</AlertTitle>
					<AlertDescription>
						<p>
							{_(
								msg`Meta no longer accepts its access. Posts to it will fail until you connect it again.`,
							)}
						</p>
						<Link
							to={`/${orgSlug}/marketing/social/accounts`}
							className="underline underline-offset-4"
						>
							{_(msg`Review accounts`)}
						</Link>
					</AlertDescription>
				</Alert>
			) : null}

			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="icon-sm"
						render={<Link to={monthLink(shiftMonth(month, -1))} />}
						aria-label={_(msg`Previous month`)}
					>
						<Icon name="chevron-left" className="rtl:rotate-180" />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						render={<Link to={monthLink(shiftMonth(month, 1))} />}
						aria-label={_(msg`Next month`)}
					>
						<Icon name="chevron-right" className="rtl:rotate-180" />
					</Button>
					<h2 className="ms-1 text-lg font-medium" aria-live="polite">
						{monthLabel}
					</h2>
					{month !== today.slice(0, 7) ? (
						<Button
							variant="ghost"
							size="sm"
							render={<Link to={monthLink(today.slice(0, 7))} />}
						>
							{_(msg`Today`)}
						</Button>
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Tabs
						value={platform ?? 'all'}
						onValueChange={(value) =>
							setParam('platform', value === 'all' ? null : String(value))
						}
					>
						<TabsList>
							<TabsTrigger value="all">{_(msg`All`)}</TabsTrigger>
							{SOCIAL_PLATFORMS.map((key) => (
								<TabsTrigger key={key} value={key}>
									<SocialPlatformIcon platform={key} />
									{_(SOCIAL_PLATFORM_LABELS[key])}
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
					<Tabs
						value={view}
						onValueChange={(value) =>
							setParam('view', value === 'list' ? 'list' : null)
						}
					>
						<TabsList>
							<TabsTrigger value="calendar" aria-label={_(msg`Calendar`)}>
								<Icon name="calendar-days" />
							</TabsTrigger>
							<TabsTrigger value="list" aria-label={_(msg`List`)}>
								<Icon name="list" />
							</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>
			</div>

			{view === 'calendar' ? (
				<div className="space-y-3">
					<SocialCalendar
						month={month}
						today={today}
						posts={visible}
						timeZone={timeZone}
						orgSlug={orgSlug}
						canWrite={canWrite}
					/>
					<SocialStatusLegend />
				</div>
			) : (
				<SocialPostList
					posts={monthPosts}
					timeZone={timeZone}
					orgSlug={orgSlug}
					empty={_(msg`No posts this month.`)}
				/>
			)}

			<section aria-labelledby="social-drafts-heading" className="space-y-3">
				<h2 id="social-drafts-heading" className="text-sm font-medium">
					{_(msg`Drafts without a date`)}
				</h2>
				<SocialPostList
					posts={visibleDrafts}
					timeZone={timeZone}
					orgSlug={orgSlug}
					empty={_(msg`No drafts.`)}
				/>
			</section>
		</div>
	)
}
