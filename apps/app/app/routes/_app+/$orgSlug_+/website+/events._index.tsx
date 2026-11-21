/**
 * Website, Events (#184, flag `website.events`): the list, and "New event"
 * (a draft opened in the editor). 404 while the flag is off. Read with
 * `read:website:any`, change with `update:website:any`.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { eventPhase, nextOccurrence } from '@repo/common/site-events'
import { pickLocalized } from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	desc,
	eq,
	OrganizationLocation,
	SiteEvent,
	SiteEventCalendarSource,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	Link,
	type LoaderFunctionArgs,
	redirect,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	connectCalendar,
	disconnectCalendar,
	syncCalendarSource,
} from '#app/utils/events/calendar-sync.server.ts'
import { requireEventsAccess } from '#app/utils/seo/site-events-access.server.ts'
import { scheduleOf } from '#app/utils/seo/site-events.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireEventsAccess(
		request,
		params.orgSlug,
		'read',
	)
	const defaultLocale = organization.siteDefaultLocale || 'en'
	const rows = await db
		.select()
		.from(SiteEvent)
		.where(eq(SiteEvent.organizationId, organization.id))
		.orderBy(desc(SiteEvent.updatedAt))
	const now = Date.now()
	// Connected Google Calendars (#319): the host only, never the address.
	const sources = await db
		.select({
			id: SiteEventCalendarSource.id,
			label: SiteEventCalendarSource.label,
			urlHint: SiteEventCalendarSource.urlHint,
			status: SiteEventCalendarSource.status,
			lastError: SiteEventCalendarSource.lastError,
			lastSyncedAt: SiteEventCalendarSource.lastSyncedAt,
			locationId: SiteEventCalendarSource.organizationLocationId,
		})
		.from(SiteEventCalendarSource)
		.where(eq(SiteEventCalendarSource.organizationId, organization.id))
		.orderBy(asc(SiteEventCalendarSource.createdAt))
	const locationRows = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(asc(OrganizationLocation.name))
	return {
		calendars: sources.map((source) => ({
			...source,
			lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
		})),
		locations: locationRows.map((location) => ({
			id: location.id,
			name:
				pickLocalized(location.name, defaultLocale, defaultLocale) ||
				location.name,
		})),
		events: rows.map((row) => {
			const schedule = scheduleOf(row)
			const next = nextOccurrence(schedule, now)
			return {
				id: row.id,
				title: pickLocalized(row.title, defaultLocale, defaultLocale),
				slug: row.slug,
				status: row.status,
				phase: eventPhase(schedule, now),
				next: next.ok ? next.occurrence.start : null,
				timezone: row.timezone,
				repeats: schedule.recurrence.frequency !== 'none',
				fromCalendar: row.sourceId !== null,
			}
		}),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireEventsAccess(
		request,
		params.orgSlug,
		'update',
	)
	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent === 'connect-calendar') {
		const locationId = String(formData.get('locationId') ?? '')
		const result = await connectCalendar({
			organizationId: organization.id,
			userId,
			locationId: locationId || null,
			address: formData.get('address'),
			label: String(formData.get('label') ?? ''),
		})
		if (!result.ok) {
			return Response.json(
				{ ok: false, error: result.error },
				{ status: result.error === 'too_many_calendars' ? 409 : 400 },
			)
		}
		return Response.json({ ok: true, report: result.report })
	}
	if (intent === 'sync-calendar') {
		const sourceId = String(formData.get('sourceId') ?? '')
		const [owned] = await db
			.select({ id: SiteEventCalendarSource.id })
			.from(SiteEventCalendarSource)
			.where(
				and(
					eq(SiteEventCalendarSource.id, sourceId),
					eq(SiteEventCalendarSource.organizationId, organization.id),
				),
			)
			.limit(1)
		if (!owned) {
			return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
		}
		const outcome = await syncCalendarSource(owned.id)
		return outcome.ok
			? Response.json({ ok: true, report: outcome.report })
			: Response.json({ ok: false, error: outcome.error }, { status: 502 })
	}
	if (intent === 'disconnect-calendar') {
		const result = await disconnectCalendar({
			organizationId: organization.id,
			sourceId: String(formData.get('sourceId') ?? ''),
		})
		return result.ok
			? Response.json({ ok: true })
			: Response.json({ ok: false, error: 'not_found' }, { status: 404 })
	}
	if (intent !== 'create-event') {
		return Response.json(
			{ ok: false, error: 'invalid_intent' },
			{ status: 400 },
		)
	}
	const [location] = await db
		.select({
			id: OrganizationLocation.id,
			timezone: OrganizationLocation.timezone,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
		.limit(1)
	const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
	const defaultLocale = organization.siteDefaultLocale || 'en'
	const [created] = await db
		.insert(SiteEvent)
		.values({
			organizationId: organization.id,
			organizationLocationId: location?.id ?? null,
			slug: `event-${Date.now().toString(36)}`,
			status: 'draft',
			title: JSON.stringify({ [defaultLocale]: 'New event' }),
			startLocal: `${tomorrow}T19:00`,
			endLocal: `${tomorrow}T21:00`,
			timezone: location?.timezone || organization.staffingTimeZone || 'UTC',
		})
		.returning({ id: SiteEvent.id })
	return redirect(`/${organization.slug}/website/events/${created!.id}`)
}

export default function WebsiteEventsRoute() {
	const { events, calendars, locations } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const createFetcher = useFetcher()
	const phaseLabel = {
		upcoming: msg`Upcoming`,
		ended: msg`Ended`,
		gone: msg`Ended`,
	} as const
	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Events</Trans>}
				description={
					<Trans>
						Announce trivia nights, live music or a holiday brunch. Each event
						gets its own page with an Add to calendar file.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<createFetcher.Form method="POST">
						<input type="hidden" name="intent" value="create-event" />
						<Button type="submit" disabled={createFetcher.state !== 'idle'}>
							<Trans>New event</Trans>
						</Button>
					</createFetcher.Form>
				}
			/>
			<CalendarSources calendars={calendars} locations={locations} />
			{events.length === 0 ? (
				<EmptyState
					title={_(msg`No events yet`)}
					description={_(
						msg`Add an event, then put the Upcoming events section on any page.`,
					)}
					icons={['calendar']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Event</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead>
									<Trans>Next</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{events.map((event) => (
								<TableRow key={event.id}>
									<TableCell>
										<Link
											to={event.id}
											className="hover:text-primary font-medium"
										>
											{event.title || event.slug}
										</Link>
										{event.repeats ? (
											<Badge variant="outline" className="ms-2 text-xs">
												<Trans>Repeats</Trans>
											</Badge>
										) : null}
										{event.fromCalendar ? (
											<Badge
												variant="outline"
												className="ms-2 text-xs"
												data-testid="from-calendar"
											>
												<Trans>From calendar</Trans>
											</Badge>
										) : null}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												event.status === 'published' ? 'secondary' : 'outline'
											}
										>
											{event.status === 'published' ? (
												<Trans>Published</Trans>
											) : event.fromCalendar ? (
												<Trans>Hidden</Trans>
											) : (
												<Trans>Draft</Trans>
											)}
										</Badge>{' '}
										<span className="text-muted-foreground text-xs">
											{_(phaseLabel[event.phase])}
										</span>
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{event.next
											? i18n.date(new Date(event.next), {
													dateStyle: 'medium',
													timeStyle: 'short',
													timeZone: event.timezone,
												})
											: '—'}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			)}
		</div>
	)
}

const CALENDAR_ERRORS = {
	invalid_calendar_address: msg`Paste the calendar's public address, a webcal:// link or its calendar ID.`,
	url_not_allowed: msg`That address cannot be used. It must be a public https:// address.`,
	fetch_failed: msg`We could not read that calendar. Check that it is public, or paste its secret address.`,
	invalid_calendar: msg`That address does not lead to a calendar.`,
	too_large: msg`That calendar is too large to import.`,
	too_many_calendars: msg`You have connected the most calendars you can.`,
	location_not_found: msg`Choose one of your locations.`,
	not_found: msg`That calendar is no longer connected.`,
} as const

/**
 * Connect a Google Calendar (#319): paste the public (or secret) address, per
 * location. Menuza reads it a few times a day and never writes to it.
 */
function CalendarSources({
	calendars,
	locations,
}: {
	calendars: Array<{
		id: string
		label: string
		urlHint: string
		status: string
		lastError: string | null
		lastSyncedAt: string | null
		locationId: string | null
	}>
	locations: Array<{ id: string; name: string }>
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok: boolean; error?: string }>()
	const [address, setAddress] = useState('')
	const [locationId, setLocationId] = useState('')
	const busy = fetcher.state !== 'idle'
	const error =
		fetcher.data && !fetcher.data.ok && fetcher.data.error
			? _(
					CALENDAR_ERRORS[
						(fetcher.data.error in CALENDAR_ERRORS
							? fetcher.data.error
							: 'fetch_failed') as keyof typeof CALENDAR_ERRORS
					],
				)
			: null
	return (
		<section aria-labelledby="calendar-title" className="space-y-3">
			<div>
				<h3 id="calendar-title" className="text-base font-medium">
					<Trans>Google Calendar</Trans>
				</h3>
				<p className="text-muted-foreground mt-1 text-sm">
					<Trans>
						Show a calendar's upcoming events here too. Menuza reads it a few
						times a day and never changes it. You can hide an event, add a photo
						and a ticket or booking link; those stay when the calendar updates.
					</Trans>
				</p>
			</div>
			<form
				className="flex flex-col gap-2 sm:flex-row"
				onSubmit={(event) => {
					event.preventDefault()
					void fetcher.submit(
						{ intent: 'connect-calendar', address, locationId },
						{ method: 'POST' },
					)
					setAddress('')
				}}
			>
				<Input
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					placeholder={_(msg`Calendar address (public or secret)`)}
					aria-label={_(msg`Calendar address`)}
					autoComplete="off"
					spellCheck={false}
					className="sm:flex-1"
				/>
				{locations.length > 1 ? (
					<select
						value={locationId}
						onChange={(event) => setLocationId(event.target.value)}
						aria-label={_(msg`Location`)}
						className="border-input bg-background h-9 rounded-md border px-2 text-sm"
					>
						<option value="">{_(msg`All locations`)}</option>
						{locations.map((location) => (
							<option key={location.id} value={location.id}>
								{location.name}
							</option>
						))}
					</select>
				) : null}
				<Button type="submit" disabled={busy || !address.trim()}>
					<Trans>Connect calendar</Trans>
				</Button>
			</form>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{calendars.length ? (
				<ul
					className="divide-border divide-y rounded-lg border"
					data-testid="calendars"
				>
					{calendars.map((calendar) => (
						<li
							key={calendar.id}
							className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
						>
							<div className="min-w-0">
								<p className="font-medium wrap-anywhere">{calendar.label}</p>
								<p className="text-muted-foreground text-xs">
									{calendar.urlHint}
									{calendar.lastSyncedAt ? (
										<>
											{' · '}
											<UpdatedAt iso={calendar.lastSyncedAt} />
										</>
									) : null}
									{calendar.status === 'error' ? (
										<span className="text-destructive">
											{' · '}
											<Trans>Could not be read, trying again soon</Trans>
										</span>
									) : null}
								</p>
							</div>
							<div className="flex gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() =>
										void fetcher.submit(
											{ intent: 'sync-calendar', sourceId: calendar.id },
											{ method: 'POST' },
										)
									}
								>
									<Trans>Update now</Trans>
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-destructive"
									disabled={busy}
									onClick={() => {
										if (
											window.confirm(
												_(
													msg`Disconnect this calendar? Its events are removed from your website.`,
												),
											)
										) {
											void fetcher.submit(
												{
													intent: 'disconnect-calendar',
													sourceId: calendar.id,
												},
												{ method: 'POST' },
											)
										}
									}}
								>
									<Trans>Disconnect</Trans>
								</Button>
							</div>
						</li>
					))}
				</ul>
			) : null}
		</section>
	)
}

function UpdatedAt({ iso }: { iso: string }) {
	const { i18n } = useLingui()
	const when = i18n.date(new Date(iso), {
		dateStyle: 'medium',
		timeStyle: 'short',
	})
	return <Trans>Updated {when}</Trans>
}
