import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useEffect, useMemo, useState } from 'react'
import { LanguageToggle } from '#app/components/kiosk/kiosk-chrome.tsx'
import { useKioskLocale } from '#app/hooks/use-kiosk-locale.ts'
import { useMyScheduleData } from '#app/hooks/use-my-schedule-data.ts'
import { loadKioskLocale } from '#app/utils/kiosk/kiosk-device.ts'
import { type TenantApiUrls } from '#app/utils/kiosk/kiosk-pair-client.ts'
import {
	createMyScheduleApi,
	MyScheduleApiError,
} from '#app/utils/my-schedule/my-schedule-api.ts'
import {
	formatDay,
	formatRange,
	nextShift,
	todayIn,
	windowFrom,
} from '#app/utils/my-schedule/my-schedule-format.ts'
import { describeGoneLink } from '#app/utils/my-schedule/my-schedule-messages.ts'
import {
	forgetLink,
	takeLink,
	type StoredLink,
} from '#app/utils/my-schedule/my-schedule-session.ts'
import { RequestsView } from './requests-view.tsx'
import { ShiftsView } from './shifts-view.tsx'
import { TimeCardsView } from './time-cards-view.tsx'

const WINDOW_DAYS = 35
const STEP_DAYS = 28

type Boot = { state: 'loading' } | { state: 'ready'; link: StoredLink | null }

/**
 * "My schedule": a person's own published shifts, recent time cards and
 * requests, opened from the link in their schedule email. It is a client app: it
 * reads the link from the address fragment (which no server sees), then talks to
 * the regional node directly. Nothing about the person passes through the App's
 * servers. English and Arabic, phone first.
 */
export function MySchedulePage({ urls }: { urls: TenantApiUrls }) {
	const { _ } = useLingui()
	const [locale, changeLocale] = useKioskLocale()
	const [boot, setBoot] = useState<Boot>({ state: 'loading' })

	useEffect(() => {
		setBoot({
			state: 'ready',
			link: takeLink(window.location, window.history),
		})
	}, [])

	const link = boot.state === 'ready' ? boot.link : null
	const api = useMemo(
		() =>
			link
				? createMyScheduleApi({
						tenantApiUrl: urls[link.region],
						token: link.token,
					})
				: null,
		[link, urls],
	)

	const [range, setRange] = useState<{ from: string; to: string } | null>(null)
	const [seen, setSeen] = useState<Set<string>>(() => new Set(['schedule']))
	const [tab, setTab] = useState('schedule')

	const schedule = useMyScheduleData(
		api ? () => api.schedule(range ?? {}) : null,
		`${range?.from ?? ''}:${range?.to ?? ''}:${link?.token.slice(-8) ?? ''}`,
	)
	const timeCards = useMyScheduleData(
		api && seen.has('time-cards') ? () => api.timeCards() : null,
		`cards:${link?.token.slice(-8) ?? ''}`,
	)
	const requests = useMyScheduleData(
		api && seen.has('requests') ? () => api.requests() : null,
		`requests:${link?.token.slice(-8) ?? ''}`,
	)

	const data = schedule.data
	// Once, a person who never picked a language gets the one their manager set.
	useEffect(() => {
		if (!data || loadKioskLocale() !== null) return
		if (data.person.locale?.toLowerCase().startsWith('ar')) {
			void changeLocale('ar')
		}
	}, [data, changeLocale])

	// A link that stopped working replaces the page; forget it so a reload says so too.
	const gone =
		schedule.error instanceof MyScheduleApiError && schedule.error.linkGone
			? schedule.error.code
			: null
	useEffect(() => {
		if (gone) forgetLink()
	}, [gone])

	if (boot.state === 'loading') {
		return <Shell locale={locale} onLocale={changeLocale} />
	}
	if (!api || gone) {
		const copy = describeGoneLink(gone ?? 'no_link', _)
		return (
			<Shell locale={locale} onLocale={changeLocale}>
				<div className="py-12">
					<Empty role="alert">
						<EmptyHeader>
							<EmptyTitle role="heading" aria-level={1}>
								{copy.title}
							</EmptyTitle>
							<EmptyDescription>{copy.body}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</div>
			</Shell>
		)
	}

	const zone = data?.scopes[0]?.timeZone ?? 'UTC'
	const today = data ? todayIn(data.serverNow, zone) : ''
	const upcoming = data ? nextShift(data.shifts, data.serverNow) : null
	const upcomingDay = upcoming ? formatDay(upcoming.localDate, locale) : ''
	const upcomingRange = upcoming
		? formatRange(upcoming.startsAt, upcoming.endsAt, upcoming.timeZone, locale)
		: ''
	const name = data
		? locale === 'ar' && data.person.firstNameAr
			? data.person.firstNameAr
			: data.person.firstName
		: ''

	return (
		<Shell
			locale={locale}
			onLocale={changeLocale}
			actions={
				<Button
					type="button"
					variant="outline"
					className="h-11 rounded-full px-4"
					onClick={() => window.print()}
				>
					<Icon name="file-text" />
					<Trans>Print</Trans>
				</Button>
			}
		>
			<header className="flex flex-col gap-1 pt-2">
				<h1 className="text-2xl font-semibold text-balance">
					{data ? <Trans>Hi {name}</Trans> : <Trans>My schedule</Trans>}
				</h1>
				{data ? (
					<p className="text-muted-foreground text-base">
						{upcoming ? (
							<Trans>
								Next shift: {upcomingDay}, <bdi>{upcomingRange}</bdi>
							</Trans>
						) : (
							<Trans>No upcoming shifts are published.</Trans>
						)}
					</p>
				) : null}
			</header>

			<Tabs
				value={tab}
				onValueChange={(next) => {
					const value = String(next)
					setTab(value)
					setSeen((current) => new Set(current).add(value))
				}}
			>
				<TabsList className="w-full print:hidden">
					<TabsTrigger value="schedule" className="flex-1">
						<Trans>Schedule</Trans>
					</TabsTrigger>
					<TabsTrigger value="time-cards" className="flex-1">
						<Trans>Time cards</Trans>
					</TabsTrigger>
					<TabsTrigger value="requests" className="flex-1">
						<Trans>Requests</Trans>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="schedule" className="pt-3">
					<ShiftsView
						api={api}
						schedule={data}
						error={schedule.error}
						refreshing={schedule.refreshing}
						locale={locale}
						canGoEarlier
						onEarlier={() =>
							data && setRange(windowFrom(data.from, -STEP_DAYS, WINDOW_DAYS))
						}
						onLater={() =>
							data && setRange(windowFrom(data.from, STEP_DAYS, WINDOW_DAYS))
						}
						onToday={() => setRange(null)}
						onChanged={() => {
							requests.reload()
						}}
					/>
				</TabsContent>
				<TabsContent value="time-cards" className="pt-3">
					<TimeCardsView
						cards={timeCards.data}
						error={timeCards.error}
						loading={timeCards.loading}
						locale={locale}
					/>
				</TabsContent>
				<TabsContent value="requests" className="pt-3">
					<RequestsView
						api={api}
						requests={requests.data}
						error={requests.error}
						loading={requests.loading}
						today={today || new Date().toISOString().slice(0, 10)}
						locale={locale}
						onChanged={requests.reload}
					/>
				</TabsContent>
			</Tabs>
			<p className="text-muted-foreground text-xs print:hidden">
				<Trans>
					This page is only for you. Do not share the link from your email.
				</Trans>
			</p>
			<span className="sr-only">{_(t`My schedule`)}</span>
		</Shell>
	)
}

function Shell({
	locale,
	onLocale,
	actions,
	children,
}: {
	locale: 'en' | 'ar'
	onLocale: (locale: 'en' | 'ar') => Promise<void>
	actions?: React.ReactNode
	children?: React.ReactNode
}) {
	return (
		<main
			id="main-content"
			className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-5 px-4 pt-3 pb-16"
		>
			<div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
				{actions}
				<LanguageToggle
					locale={locale}
					onChange={(next) => void onLocale(next)}
				/>
			</div>
			{children}
		</main>
	)
}
