/**
 * Website, Events, one event (#184): text per site language, place, time,
 * repeat rule, skipped and moved dates, link, publish. Times are wall-clock
 * in the location's time zone. 404 while `website.events` is off.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	expandOccurrences,
	parseExceptions,
	parseRecurrence,
	type SiteEventExceptions,
	type SiteEventRecurrence,
} from '@repo/common/site-events'
import {
	getSiteLocaleNativeLabel,
	parseSiteLocalesConfig,
} from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	eq,
	OrganizationLocation,
	SiteEvent,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Textarea } from '@repo/ui/textarea'
import { useMemo, useState } from 'react'
import {
	type ActionFunctionArgs,
	Link,
	type LoaderFunctionArgs,
	redirect,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { ENV } from '#app/utils/env.server.ts'
import { localizedRecord } from '#app/utils/seo/cuisine-form.server.ts'
import { requireEventsAccess } from '#app/utils/seo/site-events-access.server.ts'
import {
	prepareSiteEvent,
	siteEventInputSchema,
} from '#app/utils/seo/site-events.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'

async function loadEvent(organizationId: string, eventId: string | undefined) {
	const [event] = await db
		.select()
		.from(SiteEvent)
		.where(
			and(
				eq(SiteEvent.id, eventId ?? ''),
				eq(SiteEvent.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!event) throw new Response('Not Found', { status: 404 })
	return event
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireEventsAccess(
		request,
		params.orgSlug,
		'read',
	)
	const event = await loadEvent(organization.id, params.eventId)
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const locations = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timezone: OrganizationLocation.timezone,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(asc(OrganizationLocation.name))
	return {
		orgSlug: organization.slug,
		locales,
		defaultLocale,
		locations,
		siteOrigin: resolveSitesOrigin({
			slug: organization.slug,
			customDomain: organization.customDomain,
			baseUrl: ENV.BASE_URL ?? '',
		}),
		event: {
			id: event.id,
			slug: event.slug,
			status: event.status,
			title: localizedRecord(event.title, defaultLocale),
			description: localizedRecord(event.description, defaultLocale),
			linkLabel: localizedRecord(event.linkLabel, defaultLocale),
			locationId: event.organizationLocationId,
			imageUrl: event.imageUrl ?? '',
			linkUrl: event.linkUrl ?? '',
			experienceId: event.experienceId ?? '',
			startLocal: event.startLocal,
			endLocal: event.endLocal,
			timezone: event.timezone,
			recurrence: parseRecurrence(event.recurrence),
			exceptions: parseExceptions(event.exceptions),
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireEventsAccess(
		request,
		params.orgSlug,
		'update',
	)
	const event = await loadEvent(organization.id, params.eventId)
	const formData = await request.formData()
	const intent = String(formData.get('intent') ?? '')
	const purge = () =>
		purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)

	if (intent === 'save-event' || intent === 'publish-event') {
		let json: unknown
		try {
			json = JSON.parse(String(formData.get('event') ?? ''))
		} catch {
			return Response.json(
				{ ok: false, error: 'invalid_event' },
				{ status: 400 },
			)
		}
		const parsed = siteEventInputSchema.safeParse(json)
		if (!parsed.success) {
			return Response.json(
				{ ok: false, error: 'invalid_event' },
				{ status: 400 },
			)
		}
		const prepared = await prepareSiteEvent(organization.id, parsed.data, {
			eventId: event.id,
			fallbackTimezone: event.timezone,
		})
		if (!prepared.ok) {
			return Response.json(
				{ ok: false, error: prepared.error },
				{ status: 400 },
			)
		}
		await db
			.update(SiteEvent)
			.set({
				...prepared.values,
				...(intent === 'publish-event' ? { status: 'published' } : {}),
			})
			.where(eq(SiteEvent.id, event.id))
		await purge()
		return Response.json({ ok: true })
	}

	if (intent === 'unpublish-event') {
		// Off the site and out of the sitemap at once.
		await db
			.update(SiteEvent)
			.set({ status: 'draft' })
			.where(eq(SiteEvent.id, event.id))
		await purge()
		return Response.json({ ok: true })
	}

	if (intent === 'delete-event') {
		await db.delete(SiteEvent).where(eq(SiteEvent.id, event.id))
		await purge()
		return redirect(`/${organization.slug}/website/events`)
	}

	return Response.json({ ok: false, error: 'invalid_intent' }, { status: 400 })
}

const ERRORS = {
	invalid_event: msg`Check the event details and try again.`,
	invalid_event_time: msg`The end must be after the start, and an event lasts at most 24 hours.`,
	title_required: msg`Give the event a title.`,
	slug_taken: msg`Another event already uses this web address.`,
	invalid_link: msg`Links must be a page of your site (starting with /) or a full https:// address.`,
	location_not_found: msg`Choose one of your locations.`,
} as const

const WEEKDAYS = [
	msg`Sun`,
	msg`Mon`,
	msg`Tue`,
	msg`Wed`,
	msg`Thu`,
	msg`Fri`,
	msg`Sat`,
] as const

export default function WebsiteEventEditorRoute() {
	const data = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<{ ok: boolean; error?: string }>()
	const [title, setTitle] = useState<Record<string, string>>(data.event.title)
	const [description, setDescription] = useState<Record<string, string>>(
		data.event.description,
	)
	const [linkLabel, setLinkLabel] = useState<Record<string, string>>(
		data.event.linkLabel,
	)
	const [slug, setSlug] = useState(data.event.slug)
	const [locationId, setLocationId] = useState(data.event.locationId ?? '')
	const [imageUrl, setImageUrl] = useState(data.event.imageUrl)
	const [linkUrl, setLinkUrl] = useState(data.event.linkUrl)
	const [experienceId, setExperienceId] = useState(data.event.experienceId)
	const [startLocal, setStartLocal] = useState(data.event.startLocal)
	const [endLocal, setEndLocal] = useState(data.event.endLocal)
	const [recurrence, setRecurrence] = useState<SiteEventRecurrence>(
		data.event.recurrence,
	)
	const [exceptions, setExceptions] = useState<SiteEventExceptions>(
		data.event.exceptions,
	)
	const [skipDate, setSkipDate] = useState('')
	const [moved, setMoved] = useState({ date: '', start: '', end: '' })

	const timezone =
		data.locations.find((location) => location.id === locationId)?.timezone ??
		data.event.timezone
	const payload = {
		title,
		description,
		slug,
		locationId: locationId || null,
		imageUrl,
		linkUrl,
		linkLabel,
		experienceId,
		startLocal,
		endLocal,
		recurrence,
		exceptions,
	}
	const preview = useMemo(
		() =>
			expandOccurrences(
				{ startLocal, endLocal, timezone, recurrence, exceptions },
				{ fromMs: Date.now(), limit: 6 },
			),
		[startLocal, endLocal, timezone, recurrence, exceptions],
	)
	const submit = (intent: string) =>
		void fetcher.submit(
			{ intent, event: JSON.stringify(payload) },
			{ method: 'POST' },
		)
	const error =
		fetcher.data?.error && fetcher.data.error in ERRORS
			? _(ERRORS[fetcher.data.error as keyof typeof ERRORS])
			: null
	const weekly = recurrence.frequency === 'weekly' ? recurrence : null
	const pageUrl = `${data.siteOrigin}/events/${slug}`

	return (
		<div className="space-y-6">
			<PageHeader
				title={title[data.defaultLocale] || <Trans>Event</Trans>}
				description={
					<span dir="ltr" className="font-mono text-xs">
						{pageUrl}
					</span>
				}
				headingLevel="h2"
				size="section"
				actions={
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							render={<Link to={`/${data.orgSlug}/website/events`} />}
						>
							<Trans>All events</Trans>
						</Button>
						<Button variant="outline" onClick={() => submit('save-event')}>
							<Trans>Save</Trans>
						</Button>
						{data.event.status === 'published' ? (
							<Button
								variant="outline"
								onClick={() => submit('unpublish-event')}
							>
								<Trans>Unpublish</Trans>
							</Button>
						) : null}
						<Button
							onClick={() => submit('publish-event')}
							data-testid="publish-event"
						>
							{data.event.status === 'published' ? (
								<Trans>Save and publish</Trans>
							) : (
								<Trans>Publish</Trans>
							)}
						</Button>
					</div>
				}
			/>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{fetcher.data?.ok ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>Saved.</Trans>
				</p>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						<Trans>Details</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{data.locales.map((locale) => {
						const language = getSiteLocaleNativeLabel(locale)
						return (
							<div
								key={locale}
								className="space-y-2"
								dir={locale === 'ar' ? 'rtl' : undefined}
							>
								<Label htmlFor={`title-${locale}`}>
									<Trans>Title ({language})</Trans>
								</Label>
								<Input
									id={`title-${locale}`}
									value={title[locale] ?? ''}
									maxLength={200}
									onChange={(e) =>
										setTitle({ ...title, [locale]: e.target.value })
									}
								/>
								<Label htmlFor={`description-${locale}`}>
									<Trans>Description ({language})</Trans>
								</Label>
								<Textarea
									id={`description-${locale}`}
									value={description[locale] ?? ''}
									maxLength={5000}
									onChange={(e) =>
										setDescription({ ...description, [locale]: e.target.value })
									}
								/>
							</div>
						)
					})}
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="event-slug">
								<Trans>Web address</Trans>
							</Label>
							<Input
								id="event-slug"
								value={slug}
								dir="ltr"
								onChange={(e) => setSlug(e.target.value.toLowerCase())}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="event-location">
								<Trans>Location</Trans>
							</Label>
							<select
								id="event-location"
								className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
								value={locationId}
								onChange={(e) => setLocationId(e.target.value)}
							>
								<option value="">—</option>
								{data.locations.map((location) => (
									<option key={location.id} value={location.id}>
										{location.name}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="event-image">
								<Trans>Photo address</Trans>
							</Label>
							<Input
								id="event-image"
								value={imageUrl}
								dir="ltr"
								placeholder="https://"
								onChange={(e) => setImageUrl(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="event-link">
								<Trans>Link (book a table, tickets, any page)</Trans>
							</Label>
							<Input
								id="event-link"
								value={linkUrl}
								dir="ltr"
								placeholder="/reserve"
								onChange={(e) => setLinkUrl(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="event-link-label">
								<Trans>Link button text</Trans>
							</Label>
							<Input
								id="event-link-label"
								value={linkLabel[data.defaultLocale] ?? ''}
								maxLength={80}
								onChange={(e) =>
									setLinkLabel({
										...linkLabel,
										[data.defaultLocale]: e.target.value,
									})
								}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="event-experience">
								<Trans>Bookable experience (its web address name)</Trans>
							</Label>
							<Input
								id="event-experience"
								value={experienceId}
								dir="ltr"
								onChange={(e) => setExperienceId(e.target.value.trim())}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Its Book button shows only while online booking is on.
								</Trans>
							</p>
						</div>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						<Trans>When</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>In the location's time zone ({timezone}).</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="event-start">
								<Trans>Starts</Trans>
							</Label>
							<Input
								id="event-start"
								type="datetime-local"
								value={startLocal}
								onChange={(e) => setStartLocal(e.target.value.slice(0, 16))}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="event-end">
								<Trans>Ends</Trans>
							</Label>
							<Input
								id="event-end"
								type="datetime-local"
								value={endLocal}
								onChange={(e) => setEndLocal(e.target.value.slice(0, 16))}
							/>
						</div>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="event-repeat">
							<Trans>Repeats</Trans>
						</Label>
						<select
							id="event-repeat"
							className="border-input bg-background h-9 rounded-md border px-2 text-sm"
							value={recurrence.frequency}
							onChange={(e) => {
								const frequency = e.target
									.value as SiteEventRecurrence['frequency']
								const startDay = new Date(
									`${startLocal.slice(0, 10)}T00:00:00Z`,
								).getUTCDay()
								setRecurrence(
									frequency === 'weekly'
										? { frequency, weekdays: [startDay], interval: 1 }
										: frequency === 'monthly'
											? { frequency, mode: 'date', interval: 1 }
											: frequency === 'dates'
												? { frequency, dates: [] }
												: { frequency: 'none' },
								)
							}}
						>
							<option value="none">{_(msg`Does not repeat`)}</option>
							<option value="weekly">{_(msg`Weekly`)}</option>
							<option value="monthly">{_(msg`Monthly`)}</option>
							<option value="dates">{_(msg`On chosen dates`)}</option>
						</select>
					</div>
					{weekly ? (
						<div className="flex flex-wrap gap-3">
							{WEEKDAYS.map((label, day) => (
								<label key={day} className="flex items-center gap-1.5 text-sm">
									<Checkbox
										checked={weekly.weekdays.includes(day)}
										onCheckedChange={(checked) => {
											const weekdays = checked
												? [...weekly.weekdays, day]
												: weekly.weekdays.filter((d) => d !== day)
											if (weekdays.length)
												setRecurrence({ ...weekly, weekdays })
										}}
									/>
									{_(label)}
								</label>
							))}
						</div>
					) : null}
					{recurrence.frequency === 'monthly' ? (
						<select
							aria-label={_(msg`Monthly on`)}
							className="border-input bg-background h-9 rounded-md border px-2 text-sm"
							value={recurrence.mode}
							onChange={(e) =>
								setRecurrence({
									...recurrence,
									mode: e.target.value === 'weekday' ? 'weekday' : 'date',
								})
							}
						>
							<option value="date">{_(msg`On the same date`)}</option>
							<option value="weekday">
								{_(msg`On the same weekday (for example the second Friday)`)}
							</option>
						</select>
					) : null}
					{recurrence.frequency === 'weekly' ||
					recurrence.frequency === 'monthly' ? (
						<div className="space-y-1.5">
							<Label htmlFor="event-until">
								<Trans>Until (optional)</Trans>
							</Label>
							<Input
								id="event-until"
								type="date"
								className="w-48"
								value={recurrence.until ?? ''}
								onChange={(e) =>
									setRecurrence({
										...recurrence,
										until: e.target.value || null,
									})
								}
							/>
						</div>
					) : null}
					{recurrence.frequency === 'dates' ? (
						<div className="space-y-1.5">
							<Label htmlFor="event-dates">
								<Trans>More dates (YYYY-MM-DD, separated by commas)</Trans>
							</Label>
							<Input
								id="event-dates"
								dir="ltr"
								defaultValue={recurrence.dates.join(', ')}
								onBlur={(e) =>
									setRecurrence({
										frequency: 'dates',
										dates: e.target.value
											.split(/[,\s]+/)
											.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
									})
								}
							/>
						</div>
					) : null}
					{recurrence.frequency !== 'none' ? (
						<div className="space-y-3 rounded-md border p-3">
							<p className="text-sm font-medium">
								<Trans>Exceptions</Trans>
							</p>
							<div className="flex flex-wrap items-end gap-2">
								<Input
									type="date"
									aria-label={_(msg`Date to skip`)}
									className="w-44"
									value={skipDate}
									onChange={(e) => setSkipDate(e.target.value)}
								/>
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										if (!skipDate) return
										setExceptions({
											...exceptions,
											skipped: [
												...new Set([...exceptions.skipped, skipDate]),
											].sort(),
										})
										setSkipDate('')
									}}
								>
									<Trans>Skip this date</Trans>
								</Button>
							</div>
							<div className="flex flex-wrap items-end gap-2">
								<Input
									type="date"
									aria-label={_(msg`Date to move`)}
									className="w-44"
									value={moved.date}
									onChange={(e) => setMoved({ ...moved, date: e.target.value })}
								/>
								<Input
									type="time"
									aria-label={_(msg`New start`)}
									className="w-32"
									value={moved.start}
									onChange={(e) =>
										setMoved({ ...moved, start: e.target.value })
									}
								/>
								<Input
									type="time"
									aria-label={_(msg`New end`)}
									className="w-32"
									value={moved.end}
									onChange={(e) => setMoved({ ...moved, end: e.target.value })}
								/>
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										if (!moved.date || !moved.start || !moved.end) return
										setExceptions({
											...exceptions,
											moved: [
												...exceptions.moved.filter(
													(m) => m.date !== moved.date,
												),
												moved,
											],
										})
										setMoved({ date: '', start: '', end: '' })
									}}
								>
									<Trans>Change this date's time</Trans>
								</Button>
							</div>
							<ul className="flex flex-wrap gap-2">
								{exceptions.skipped.map((date) => (
									<li key={`s-${date}`}>
										<Badge variant="outline" className="gap-1">
											<Trans>Skipped {date}</Trans>
											<button
												type="button"
												aria-label={_(msg`Remove`)}
												onClick={() =>
													setExceptions({
														...exceptions,
														skipped: exceptions.skipped.filter(
															(d) => d !== date,
														),
													})
												}
											>
												×
											</button>
										</Badge>
									</li>
								))}
								{exceptions.moved.map((entry) => {
									const { date, start, end } = entry
									return (
										<li key={`m-${date}`}>
											<Badge variant="outline" className="gap-1">
												<Trans>
													{date}: {start}–{end}
												</Trans>
												<button
													type="button"
													aria-label={_(msg`Remove`)}
													onClick={() =>
														setExceptions({
															...exceptions,
															moved: exceptions.moved.filter(
																(m) => m.date !== date,
															),
														})
													}
												>
													×
												</button>
											</Badge>
										</li>
									)
								})}
							</ul>
						</div>
					) : null}
					<div>
						<p className="text-sm font-medium">
							<Trans>Next dates</Trans>
						</p>
						<ul
							className="text-muted-foreground mt-1 space-y-0.5 text-sm"
							data-testid="event-preview"
						>
							{preview.map((occurrence) => (
								<li key={occurrence.date}>
									{i18n.date(new Date(occurrence.startMs), {
										dateStyle: 'full',
										timeStyle: 'short',
										timeZone: timezone,
									})}
								</li>
							))}
						</ul>
					</div>
				</CardContent>
			</Card>
			<div>
				<fetcher.Form method="POST">
					<input type="hidden" name="intent" value="delete-event" />
					<Button type="submit" variant="destructive" size="sm">
						<Trans>Delete event</Trans>
					</Button>
				</fetcher.Form>
			</div>
		</div>
	)
}
