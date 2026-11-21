/**
 * #319: connecting a Google Calendar and keeping the website's events in step
 * with it. The feed is a fixture served by an injected `fetch`: nothing here
 * reaches a real calendar host.
 */
import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	SiteEvent,
	SiteEventCalendarSource,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { buildPublicEventsPayload } from '#app/utils/seo/site-events.server.ts'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import { fetchCalendarFeed } from './calendar-fetch.server.ts'
import {
	CALENDAR_FAILURE_RETRY_MS,
	CALENDAR_SYNC_INTERVAL_MS,
	MAX_CALENDARS_PER_ORGANIZATION,
	connectCalendar,
	disconnectCalendar,
	syncCalendarSource,
	syncDueCalendars,
} from './calendar-sync.server.ts'

function titleEn(raw: string) {
	return (JSON.parse(raw) as { en: string }).en
}

const NOW = Date.UTC(2026, 2, 1, 12, 0, 0)
const SECRET_URL =
	'https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-SECRETTOKEN123/basic.ics'
const publicResolve = async () => ['142.250.1.1']

function vevent(lines: string[]) {
	return `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT`
}
function feed(...events: string[]) {
	return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Pub nights\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
}
const quiz = (title = 'Quiz night', extra: string[] = []) =>
	vevent([
		'UID:quiz@google.com',
		`SUMMARY:${title}`,
		'DESCRIPTION:Teams of four',
		'DTSTART;TZID=America/New_York:20260312T200000',
		'DTEND;TZID=America/New_York:20260312T220000',
		...extra,
	])
const band = vevent([
	'UID:band@google.com',
	'SUMMARY:Live band',
	'DTSTART;TZID=America/New_York:20260320T210000',
	'DTEND;TZID=America/New_York:20260320T230000',
])

function serve(body: string, init: ResponseInit = {}) {
	return vi.fn(
		async () =>
			new Response(body, {
				status: 200,
				headers: { 'content-type': 'text/calendar; charset=utf-8' },
				...init,
			}),
	)
}

async function setup(options: { events?: boolean } = {}) {
	const ctx = await setupSeoOrganization()
	if (options.events !== false) {
		await setOrgFlag(ctx.organization.id, 'website.events', true)
	}
	await db
		.update(Organization)
		.set({ staffingTimeZone: 'America/New_York' })
		.where(eq(Organization.id, ctx.organization.id))
	return ctx
}

function deps(fetchMock: ReturnType<typeof serve>, now = NOW) {
	return {
		fetch: fetchMock as unknown as typeof fetch,
		resolve: publicResolve,
		now: () => now,
		wake: vi.fn(async () => true),
		purge: vi.fn(async () => true),
	}
}

async function connect(
	ctx: Awaited<ReturnType<typeof setup>>,
	body: string,
	address: string = SECRET_URL,
	extra: Partial<Parameters<typeof connectCalendar>[0]> = {},
) {
	const d = deps(serve(body))
	const result = await connectCalendar(
		{
			organizationId: ctx.organization.id,
			userId: ctx.userId,
			locationId: null,
			address,
			...extra,
		},
		d,
	)
	return { result, d }
}

const eventsOf = (sourceId: string) =>
	db.select().from(SiteEvent).where(eq(SiteEvent.sourceId, sourceId))

describe('connecting a calendar (#319)', () => {
	it('reads the feed, stores the events and keeps the address encrypted', async () => {
		const ctx = await setup()
		const { result, d } = await connect(ctx, feed(quiz(), band))
		expect(result).toMatchObject({ ok: true, report: { created: 2 } })
		if (!result.ok) return
		const [source] = await db
			.select()
			.from(SiteEventCalendarSource)
			.where(eq(SiteEventCalendarSource.id, result.sourceId))
		expect(source).toMatchObject({
			organizationId: ctx.organization.id,
			label: 'Pub nights',
			urlHint: 'calendar.google.com',
			status: 'active',
			timezone: 'America/New_York',
		})
		// The secret address is never stored or shown in the clear.
		expect(JSON.stringify(source)).not.toContain('SECRETTOKEN123')
		expect(source!.urlEncrypted).not.toContain('calendar.google.com')
		expect(source!.nextSyncAt!.getTime()).toBe(NOW + CALENDAR_SYNC_INTERVAL_MS)
		// The next wake-up is scheduled, and the cache purged.
		expect(d.wake).toHaveBeenCalledWith(
			result.sourceId,
			new Date(NOW + CALENDAR_SYNC_INTERVAL_MS),
		)
		expect(d.purge).toHaveBeenCalledWith(ctx.organization.id)
		const rows = await eventsOf(result.sourceId)
		expect(rows).toHaveLength(2)
		expect(rows.every((row) => row.status === 'published')).toBe(true)
		expect(rows.find((row) => row.sourceKey?.startsWith('quiz'))).toMatchObject(
			{
				startLocal: '2026-03-12T20:00',
				endLocal: '2026-03-12T22:00',
				timezone: 'America/New_York',
			},
		)
	})

	it('turns a calendar id and an embed link into the public feed', async () => {
		const ctx = await setup()
		const calls: string[] = []
		const d = {
			...deps(serve(feed(quiz()))),
			fetch: vi.fn(async (url: string) => {
				calls.push(url)
				return new Response(feed(quiz()), {
					headers: { 'content-type': 'text/calendar' },
				})
			}) as unknown as typeof fetch,
		}
		await connectCalendar(
			{
				organizationId: ctx.organization.id,
				userId: ctx.userId,
				locationId: null,
				address: 'pub@group.calendar.google.com',
			},
			d,
		)
		await connectCalendar(
			{
				organizationId: ctx.organization.id,
				userId: ctx.userId,
				locationId: null,
				address:
					'https://calendar.google.com/calendar/embed?src=pub%40group.calendar.google.com',
			},
			d,
		)
		expect(calls).toEqual([
			'https://calendar.google.com/calendar/ical/pub%40group.calendar.google.com/public/basic.ics',
			'https://calendar.google.com/calendar/ical/pub%40group.calendar.google.com/public/basic.ics',
		])
	})

	it('shows the imported events with the events made in Menuza, as plain text', async () => {
		const ctx = await setup()
		await connect(ctx, feed(quiz('<script>alert(1)</script> Quiz'), band))
		const { events } = await buildPublicEventsPayload(
			{ id: ctx.organization.id, siteDefaultLocale: 'en' },
			{ now: new Date(NOW) },
		)
		expect(events.map((event) => event.title).sort()).toEqual([
			'<script>alert(1)</script> Quiz',
			'Live band',
		])
		// Plain strings: Sites renders them escaped, never as markup.
		expect(typeof events[0]!.title).toBe('string')
		expect(
			events.find((event) => event.title === 'Live band')?.occurrences[0],
		).toMatchObject({
			date: '2026-03-20',
		})
	})

	it('places a location calendar in that location and its time zone', async () => {
		const ctx = await setup()
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: ctx.organization.id,
				name: 'Airport',
				slug: 'airport',
				timezone: 'Asia/Riyadh',
			})
			.returning({ id: OrganizationLocation.id })
		const { result } = await connect(
			ctx,
			feed(
				vevent([
					'UID:u@x',
					'SUMMARY:Utc show',
					'DTSTART:20260312T170000Z',
					'DTEND:20260312T190000Z',
				]),
			),
			SECRET_URL,
			{ locationId: location!.id },
		)
		if (!result.ok) throw new Error(result.error)
		const [row] = await eventsOf(result.sourceId)
		expect(row).toMatchObject({
			organizationLocationId: location!.id,
			startLocal: '2026-03-12T20:00',
			timezone: 'Asia/Riyadh',
		})
	})

	it("refuses another organization's location and more than five calendars", async () => {
		const ctx = await setup()
		const other = await setup()
		const [foreign] = await db
			.insert(OrganizationLocation)
			.values({ organizationId: other.organization.id, name: 'X', slug: 'x' })
			.returning({ id: OrganizationLocation.id })
		const refused = await connect(ctx, feed(quiz()), SECRET_URL, {
			locationId: foreign!.id,
		})
		expect(refused.result).toEqual({ ok: false, error: 'location_not_found' })
		for (let i = 0; i < MAX_CALENDARS_PER_ORGANIZATION; i++) {
			expect((await connect(ctx, feed(quiz()))).result.ok).toBe(true)
		}
		expect((await connect(ctx, feed(quiz()))).result).toEqual({
			ok: false,
			error: 'too_many_calendars',
		})
	})
})

describe('events appear and stay in step with the calendar (#319)', () => {
	it('brings a new calendar event to the site at the next update, within the interval', async () => {
		const ctx = await setup()
		const { result } = await connect(ctx, feed(quiz()))
		if (!result.ok) throw new Error(result.error)
		expect(await eventsOf(result.sourceId)).toHaveLength(1)
		const later = NOW + CALENDAR_SYNC_INTERVAL_MS
		const outcome = await syncCalendarSource(
			result.sourceId,
			deps(serve(feed(quiz(), band)), later),
		)
		expect(outcome).toMatchObject({ ok: true, report: { created: 1, kept: 1 } })
		const titles = (await eventsOf(result.sourceId))
			.map((row) => titleEn(row.title))
			.sort()
		expect(titles).toEqual(['Live band', 'Quiz night'])
		const [source] = await db
			.select()
			.from(SiteEventCalendarSource)
			.where(eq(SiteEventCalendarSource.id, result.sourceId))
		expect(source!.lastSyncedAt!.getTime()).toBe(later)
		expect(source!.nextSyncAt!.getTime()).toBe(
			later + CALENDAR_SYNC_INTERVAL_MS,
		)
	})

	it('a hidden imported event stays hidden, and its photo and link stay, after updates', async () => {
		const ctx = await setup()
		const { result } = await connect(ctx, feed(quiz(), band))
		if (!result.ok) throw new Error(result.error)
		const rows = await eventsOf(result.sourceId)
		const quizRow = rows.find((row) => row.sourceKey?.startsWith('quiz'))!
		await db
			.update(SiteEvent)
			.set({
				status: 'draft',
				imageUrl: 'https://cdn.example/quiz.jpg',
				linkUrl: 'https://tickets.example/quiz',
				linkLabel: JSON.stringify({ en: 'Tickets' }),
				slug: 'my-quiz',
			})
			.where(eq(SiteEvent.id, quizRow.id))
		// The calendar renames it and moves it an hour.
		const changed = quiz('Big quiz night').replace('T200000', 'T190000')
		const outcome = await syncCalendarSource(
			result.sourceId,
			deps(serve(feed(changed, band)), NOW + CALENDAR_SYNC_INTERVAL_MS),
		)
		expect(outcome).toMatchObject({ ok: true, report: { updated: 1 } })
		const [after] = await db
			.select()
			.from(SiteEvent)
			.where(eq(SiteEvent.id, quizRow.id))
		// What the calendar owns follows it...
		expect(titleEn(after!.title)).toBe('Big quiz night')
		expect(after!.startLocal).toBe('2026-03-12T19:00')
		// ...what the operator added does not change.
		expect(after).toMatchObject({
			status: 'draft',
			imageUrl: 'https://cdn.example/quiz.jpg',
			linkUrl: 'https://tickets.example/quiz',
			slug: 'my-quiz',
		})
		// Still hidden from the public site.
		const { events } = await buildPublicEventsPayload(
			{ id: ctx.organization.id, siteDefaultLocale: 'en' },
			{ now: new Date(NOW) },
		)
		expect(events.map((event) => event.title)).toEqual(['Live band'])
	})

	it('removes an event from the site when it is deleted or cancelled in the calendar', async () => {
		const ctx = await setup()
		const { result } = await connect(ctx, feed(quiz(), band))
		if (!result.ok) throw new Error(result.error)
		// Deleted: gone from the feed.
		const deleted = await syncCalendarSource(
			result.sourceId,
			deps(serve(feed(band)), NOW + CALENDAR_SYNC_INTERVAL_MS),
		)
		expect(deleted).toMatchObject({ ok: true, report: { removed: 1, kept: 1 } })
		expect(
			(await eventsOf(result.sourceId)).map((row) => titleEn(row.title)),
		).toEqual(['Live band'])
		const { events } = await buildPublicEventsPayload(
			{ id: ctx.organization.id, siteDefaultLocale: 'en' },
			{ now: new Date(NOW) },
		)
		expect(events.map((event) => event.title)).toEqual(['Live band'])
		// Cancelled: still in the feed, marked cancelled.
		const cancelled = band.replace(
			'SUMMARY:Live band',
			'STATUS:CANCELLED\r\nSUMMARY:Live band',
		)
		await syncCalendarSource(
			result.sourceId,
			deps(serve(feed(cancelled)), NOW + 2 * CALENDAR_SYNC_INTERVAL_MS),
		)
		expect(await eventsOf(result.sourceId)).toHaveLength(0)
	})

	it('never touches events made in Menuza or imported by another calendar', async () => {
		const ctx = await setup()
		const [own] = await db
			.insert(SiteEvent)
			.values({
				organizationId: ctx.organization.id,
				slug: 'own',
				status: 'published',
				title: JSON.stringify({ en: 'Made here' }),
				startLocal: '2026-03-14T19:00',
				endLocal: '2026-03-14T21:00',
				timezone: 'America/New_York',
			})
			.returning({ id: SiteEvent.id })
		const first = await connect(ctx, feed(quiz()))
		const second = await connect(ctx, feed(band))
		if (!first.result.ok || !second.result.ok) throw new Error('connect')
		await syncCalendarSource(
			first.result.sourceId,
			deps(serve(feed()), NOW + CALENDAR_SYNC_INTERVAL_MS),
		)
		expect(await eventsOf(first.result.sourceId)).toHaveLength(0)
		expect(await eventsOf(second.result.sourceId)).toHaveLength(1)
		const [kept] = await db
			.select()
			.from(SiteEvent)
			.where(eq(SiteEvent.id, own!.id))
		expect(kept).toBeDefined()
	})

	it('keeps every event and retries in an hour when the calendar cannot be read', async () => {
		const ctx = await setup()
		const { result } = await connect(ctx, feed(quiz(), band))
		if (!result.ok) throw new Error(result.error)
		const later = NOW + CALENDAR_SYNC_INTERVAL_MS
		for (const response of [
			() => new Response('nope', { status: 503 }),
			() =>
				new Response('<html><script>alert(1)</script></html>', {
					headers: { 'content-type': 'text/html' },
				}),
			// A feed cut off before its end must not look like an empty calendar.
			() =>
				new Response('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:cut@x', {
					headers: { 'content-type': 'text/calendar' },
				}),
		]) {
			const d = {
				...deps(serve(''), later),
				fetch: vi.fn(async () => response()) as never,
			}
			const outcome = await syncCalendarSource(result.sourceId, d)
			// A bad answer is a refusal to remove anything.
			expect(outcome.ok).toBe(false)
			expect(await eventsOf(result.sourceId)).toHaveLength(2)
		}
		const failing = await syncCalendarSource(result.sourceId, {
			...deps(serve(''), later),
			fetch: vi.fn(async () => new Response('x', { status: 500 })) as never,
		})
		expect(failing).toEqual({ ok: false, error: 'fetch_failed' })
		const [source] = await db
			.select()
			.from(SiteEventCalendarSource)
			.where(eq(SiteEventCalendarSource.id, result.sourceId))
		expect(source).toMatchObject({ status: 'error', lastError: 'fetch_failed' })
		expect(source!.nextSyncAt!.getTime()).toBe(
			later + CALENDAR_FAILURE_RETRY_MS,
		)
		// The error is a code: never the address.
		expect(JSON.stringify(source)).not.toContain('SECRETTOKEN123')
	})

	it('does nothing while website events are off, and a paused source is skipped', async () => {
		const ctx = await setup({ events: false })
		const connected = await connect(ctx, feed(quiz()))
		expect(connected.result.ok).toBe(true)
		if (!connected.result.ok) return
		const fetchMock = serve(feed(quiz(), band))
		expect(
			await syncCalendarSource(
				connected.result.sourceId,
				deps(fetchMock, NOW + 1),
			),
		).toEqual({ ok: false, error: 'events_disabled' })
		expect(fetchMock).not.toHaveBeenCalled()
		await db
			.update(SiteEventCalendarSource)
			.set({ status: 'paused' })
			.where(eq(SiteEventCalendarSource.id, connected.result.sourceId))
		expect(
			await syncCalendarSource(connected.result.sourceId, deps(fetchMock)),
		).toEqual({
			ok: false,
			error: 'paused',
		})
	})

	it('a wake-up for a source that was already synced does nothing, so wake-ups never multiply', async () => {
		const ctx = await setup()
		const { result } = await connect(ctx, feed(quiz()))
		if (!result.ok) throw new Error(result.error)
		const d = deps(serve(feed(quiz())), NOW + 60_000)
		expect(
			await syncCalendarSource(result.sourceId, d, { onlyIfDue: true }),
		).toEqual({
			ok: false,
			error: 'not_due',
		})
		expect(d.fetch).not.toHaveBeenCalled()
		expect(d.wake).not.toHaveBeenCalled()
	})
})

describe('the hourly sweep (#319)', () => {
	it('syncs only the sources that are due and lets one failure pass', async () => {
		const ctx = await setup()
		const a = await connect(ctx, feed(quiz()))
		const b = await connect(ctx, feed(band))
		const c = await connect(ctx, feed(quiz()))
		if (!a.result.ok || !b.result.ok || !c.result.ok) throw new Error('connect')
		const later = NOW + CALENDAR_SYNC_INTERVAL_MS + 1
		// `c` is not due yet.
		await db
			.update(SiteEventCalendarSource)
			.set({ nextSyncAt: new Date(later + 3_600_000) })
			.where(eq(SiteEventCalendarSource.id, c.result.sourceId))
		const seen: string[] = []
		const d = {
			...deps(serve(''), later),
			fetch: vi.fn(async () => {
				seen.push('call')
				if (seen.length === 1) throw new Error('network down')
				return new Response(feed(quiz(), band), {
					headers: { 'content-type': 'text/calendar' },
				})
			}) as never,
		}
		const sweep = await syncDueCalendars(d)
		expect(sweep.synced + sweep.failed).toBeGreaterThanOrEqual(2)
		expect(sweep.failed).toBeGreaterThanOrEqual(1)
		expect(sweep.synced).toBeGreaterThanOrEqual(1)
		expect(seen.length).toBeLessThanOrEqual(sweep.due)
		// `c` was left alone.
		const [source] = await db
			.select()
			.from(SiteEventCalendarSource)
			.where(eq(SiteEventCalendarSource.id, c.result.sourceId))
		expect(source!.lastSyncedAt!.getTime()).toBe(NOW)
	})
})

describe('disconnecting (#319)', () => {
	it('removes the connection and its imported events, nothing else', async () => {
		const ctx = await setup()
		const { result } = await connect(ctx, feed(quiz(), band))
		if (!result.ok) throw new Error(result.error)
		const other = await setup()
		expect(
			await disconnectCalendar({
				organizationId: other.organization.id,
				sourceId: result.sourceId,
				purge: vi.fn(),
			}),
		).toEqual({ ok: false })
		expect(await eventsOf(result.sourceId)).toHaveLength(2)
		expect(
			await disconnectCalendar({
				organizationId: ctx.organization.id,
				sourceId: result.sourceId,
				purge: vi.fn(),
			}),
		).toEqual({ ok: true })
		expect(await eventsOf(result.sourceId)).toHaveLength(0)
		expect(
			await db
				.select()
				.from(SiteEventCalendarSource)
				.where(eq(SiteEventCalendarSource.id, result.sourceId)),
		).toHaveLength(0)
	})
})

describe('the address is guarded against server-side request forgery (#319)', () => {
	const calendar = feed(quiz())
	const ok = (body = calendar) =>
		vi.fn(
			async () =>
				new Response(body, { headers: { 'content-type': 'text/calendar' } }),
		)

	it('refuses http, private hosts, internal names and private DNS answers', async () => {
		for (const [url, resolve] of [
			['http://calendar.example/x.ics', publicResolve],
			['https://localhost/x.ics', publicResolve],
			['https://127.0.0.1/x.ics', publicResolve],
			['https://169.254.169.254/latest/meta-data', publicResolve],
			['https://[::1]/x.ics', publicResolve],
			['https://internal.service.internal/x.ics', publicResolve],
			['https://calendar.example/x.ics', async () => ['10.0.0.5']],
			['https://calendar.example/x.ics', async () => ['192.168.1.9']],
			['https://calendar.example/x.ics', async () => []],
		] as const) {
			const fetchMock = ok()
			const result = await fetchCalendarFeed(url, {
				fetch: fetchMock as unknown as typeof fetch,
				resolve,
			})
			expect({ url, ok: result.ok }).toEqual({ url, ok: false })
			expect({ url, calls: fetchMock.mock.calls.length }).toEqual({
				url,
				calls: 0,
			})
		}
	})

	it('checks every redirect hop again', async () => {
		let hop = 0
		const fetchMock = vi.fn(async () => {
			hop++
			return hop === 1
				? new Response(null, {
						status: 302,
						headers: { location: 'https://169.254.169.254/latest/meta-data' },
					})
				: new Response(calendar, {
						headers: { 'content-type': 'text/calendar' },
					})
		})
		const result = await fetchCalendarFeed('https://calendar.example/a.ics', {
			fetch: fetchMock as unknown as typeof fetch,
			resolve: publicResolve,
		})
		expect(result).toEqual({ ok: false, error: 'url_not_allowed' })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		// A redirect to a public https host is followed.
		hop = 1
		const followed = await fetchCalendarFeed('https://calendar.example/a.ics', {
			fetch: vi.fn(async (url: string) =>
				new URL(url).hostname === 'calendar.example'
					? new Response(null, {
							status: 301,
							headers: { location: 'https://cdn.calendar.example/b.ics' },
						})
					: new Response(calendar, {
							headers: { 'content-type': 'text/calendar' },
						}),
			) as never,
			resolve: publicResolve,
		})
		expect(followed.ok).toBe(true)
		// A redirect loop ends.
		const loop = await fetchCalendarFeed('https://calendar.example/a.ics', {
			fetch: vi.fn(
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: 'https://calendar.example/a.ics' },
					}),
			) as never,
			resolve: publicResolve,
		})
		expect(loop).toEqual({ ok: false, error: 'fetch_failed' })
	})

	it('refuses anything that is not a calendar, and anything too large', async () => {
		const html = await fetchCalendarFeed('https://calendar.example/x', {
			fetch: ok('<html></html>') as never,
			resolve: publicResolve,
		})
		expect(html).toEqual({ ok: false, error: 'invalid_calendar' })
		const json = await fetchCalendarFeed('https://calendar.example/x', {
			fetch: vi.fn(
				async () =>
					new Response('{"a":1}', {
						headers: { 'content-type': 'application/json' },
					}),
			) as never,
			resolve: publicResolve,
		})
		expect(json).toEqual({ ok: false, error: 'invalid_calendar' })
		const huge = await fetchCalendarFeed('https://calendar.example/x', {
			fetch: vi.fn(
				async () =>
					new Response(`BEGIN:VCALENDAR\n${'X'.repeat(3 * 1024 * 1024)}`, {
						headers: { 'content-type': 'text/calendar' },
					}),
			) as never,
			resolve: publicResolve,
		})
		expect(huge).toEqual({ ok: false, error: 'too_large' })
	})

	it('connect stores nothing for an address it refuses', async () => {
		const ctx = await setup()
		for (const address of [
			'http://calendar.example/x.ics',
			'https://169.254.169.254/x',
			'javascript:alert(1)',
			'not an address',
			'',
		]) {
			const { result } = await connect(ctx, feed(quiz()), address)
			expect({ address, ok: result.ok }).toEqual({ address, ok: false })
		}
		expect(
			await db
				.select()
				.from(SiteEventCalendarSource)
				.where(eq(SiteEventCalendarSource.organizationId, ctx.organization.id)),
		).toHaveLength(0)
	})
})
