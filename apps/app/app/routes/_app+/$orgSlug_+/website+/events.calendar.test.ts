/**
 * #319: the Events screen connects a Google Calendar and edits imported events:
 * only what the operator adds can be changed, and a sync leaves it alone.
 */
import { db, eq, SiteEvent, SiteEventCalendarSource } from '@repo/database'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fetchModule from '#app/utils/events/calendar-fetch.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	callAction,
	callLoader,
	setOrgFlag,
	setupSeoOrganization,
} from '#tests/seo-utils.ts'
import {
	action as editorAction,
	loader as editorLoader,
} from './events.$eventId.tsx'
import { action as listAction, loader as listLoader } from './events._index.tsx'

function titleEn(raw: string) {
	return (JSON.parse(raw) as { en: string }).en
}

const feedText = vi.hoisted(() => ({ current: '' }))

// The network is the external boundary; the address handling, storage and
// reconciliation are real.
vi.mock(
	'#app/utils/events/calendar-fetch.server.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof fetchModule>()),
		fetchCalendarFeed: vi.fn(async () => ({
			ok: true,
			text: feedText.current,
		})),
	}),
)
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))
// jobs-cron is the other external boundary: the sync asks it to wake the App at
// the next update.
const wakes = vi.hoisted(() => ({ calls: 0 }))

beforeEach(() => {
	wakes.calls = 0
	server.use(
		http.post(/\/workflows\/calendar-sync\/start$/u, () => {
			wakes.calls++
			return HttpResponse.json({ success: true })
		}),
	)
})

const future = (days: number) => {
	const d = new Date(Date.now() + days * 86_400_000)
	return d.toISOString().slice(0, 10).replace(/-/gu, '')
}
const feed = (...titles: string[]) =>
	`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${titles
		.map(
			(title, i) =>
				`BEGIN:VEVENT\r\nUID:e${i}@x\r\nSUMMARY:${title}\r\nDTSTART;TZID=America/New_York:${future(5 + i)}T200000\r\nDTEND;TZID=America/New_York:${future(5 + i)}T220000\r\nEND:VEVENT`,
		)
		.join('\r\n')}\r\nEND:VCALENDAR\r\n`

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const ctx = await setupSeoOrganization(role)
	await setOrgFlag(ctx.organization.id, 'website.events', true)
	return ctx
}
const base = (ctx: Awaited<ReturnType<typeof setup>>) =>
	`http://localhost:3000/${ctx.organization.slug}/website/events`
const list = (
	ctx: Awaited<ReturnType<typeof setup>>,
	fields: Record<string, string>,
) =>
	callAction(listAction, {
		url: `${base(ctx)}?index`,
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug },
		fields,
	})
const editor = (
	ctx: Awaited<ReturnType<typeof setup>>,
	eventId: string,
	fields: Record<string, string>,
) =>
	callAction(editorAction, {
		url: `${base(ctx)}/${eventId}`,
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug, eventId },
		fields,
	})

async function connected(ctx: Awaited<ReturnType<typeof setup>>, text: string) {
	feedText.current = text
	const response = await list(ctx, {
		intent: 'connect-calendar',
		address:
			'https://calendar.google.com/calendar/ical/x%40group.calendar.google.com/public/basic.ics',
		locationId: '',
	})
	expect(response.status).toBe(200)
	const [source] = await db
		.select()
		.from(SiteEventCalendarSource)
		.where(eq(SiteEventCalendarSource.organizationId, ctx.organization.id))
	return source!
}

describe('Events screen: connecting a calendar (#319)', () => {
	it('connects, imports the events and lists them marked as from the calendar', async () => {
		const ctx = await setup()
		const source = await connected(ctx, feed('Quiz', 'Live band'))
		expect(source.urlHint).toBe('calendar.google.com')
		// The next update is scheduled with jobs-cron.
		expect(wakes.calls).toBeGreaterThanOrEqual(1)
		const data = (await callLoader(listLoader as never, {
			url: base(ctx),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
		})) as unknown as {
			events: Array<{ title: string; fromCalendar: boolean; status: string }>
			calendars: Array<{ id: string; label: string; urlHint: string }>
		}
		expect(data.events.map((event) => event.title).sort()).toEqual([
			'Live band',
			'Quiz',
		])
		expect(data.events.every((event) => event.fromCalendar)).toBe(true)
		expect(data.calendars).toHaveLength(1)
		// The address is never sent to the page, only its host.
		expect(JSON.stringify(data)).not.toContain('public/basic.ics')
		expect(JSON.stringify(data)).not.toContain('urlEncrypted')
	})

	it('refuses an address that is not a calendar address, with a code', async () => {
		const ctx = await setup()
		const response = await list(ctx, {
			intent: 'connect-calendar',
			address: 'javascript:alert(1)',
			locationId: '',
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({
			ok: false,
			error: 'invalid_calendar_address',
		})
	})

	it('a viewer cannot connect, update or disconnect, and another organization cannot touch it', async () => {
		const ctx = await setup()
		const source = await connected(ctx, feed('Quiz'))
		const viewer = await setup('viewer')
		const attempts: Array<Record<string, string>> = [
			{
				intent: 'connect-calendar',
				address: 'https://x.example/a.ics',
				locationId: '',
			},
			{ intent: 'sync-calendar', sourceId: source.id },
			{ intent: 'disconnect-calendar', sourceId: source.id },
		]
		for (const fields of attempts) {
			const response = await list(viewer, fields)
			expect(response.status).toBe(403)
		}
		const other = await setup()
		for (const intent of ['sync-calendar', 'disconnect-calendar']) {
			const response = await list(other, { intent, sourceId: source.id })
			expect(response.status).toBe(404)
		}
		expect(
			await db
				.select()
				.from(SiteEvent)
				.where(eq(SiteEvent.sourceId, source.id)),
		).toHaveLength(1)
	})

	it('Update now reads the calendar again and Disconnect removes its events', async () => {
		const ctx = await setup()
		const source = await connected(ctx, feed('Quiz'))
		feedText.current = feed('Quiz', 'Live band')
		const sync = await list(ctx, {
			intent: 'sync-calendar',
			sourceId: source.id,
		})
		expect(sync.status).toBe(200)
		expect(
			await db
				.select()
				.from(SiteEvent)
				.where(eq(SiteEvent.sourceId, source.id)),
		).toHaveLength(2)
		const gone = await list(ctx, {
			intent: 'disconnect-calendar',
			sourceId: source.id,
		})
		expect(gone.status).toBe(200)
		expect(
			await db
				.select()
				.from(SiteEvent)
				.where(eq(SiteEvent.organizationId, ctx.organization.id)),
		).toHaveLength(0)
	})
})

describe('Editing an imported event (#319)', () => {
	async function imported(ctx: Awaited<ReturnType<typeof setup>>) {
		const source = await connected(ctx, feed('Quiz'))
		const [row] = await db
			.select()
			.from(SiteEvent)
			.where(eq(SiteEvent.sourceId, source.id))
		return { source, row: row! }
	}

	it('the editor tells it is from the calendar and shows its text as read-only data', async () => {
		const ctx = await setup()
		const { row } = await imported(ctx)
		const data = (await callLoader(editorLoader as never, {
			url: `${base(ctx)}/${row.id}`,
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug, eventId: row.id },
		})) as unknown as {
			source: { label: string } | null
			event: { title: Record<string, string> }
		}
		expect(data.source).toMatchObject({ urlHint: 'calendar.google.com' })
		expect(data.event.title.en).toBe('Quiz')
	})

	it('saves a photo, a link and hiding, and refuses to change the calendar-owned text or time', async () => {
		const ctx = await setup()
		const { row } = await imported(ctx)
		const saved = await editor(ctx, row.id, {
			intent: 'save-imported',
			imageUrl: 'https://cdn.example/quiz.jpg',
			linkUrl: 'https://tickets.example/quiz',
			linkLabel: 'Tickets',
			visible: 'false',
		})
		expect(saved.status).toBe(200)
		const [after] = await db
			.select()
			.from(SiteEvent)
			.where(eq(SiteEvent.id, row.id))
		expect(after).toMatchObject({
			status: 'draft',
			imageUrl: 'https://cdn.example/quiz.jpg',
			linkUrl: 'https://tickets.example/quiz',
		})
		expect(JSON.parse(after!.linkLabel!)).toEqual({ en: 'Tickets' })
		// The calendar's text and time are untouched.
		expect(after!.title).toBe(row.title)
		expect(after!.startLocal).toBe(row.startLocal)

		for (const intent of ['save-event', 'publish-event', 'delete-event']) {
			const refused = await editor(ctx, row.id, {
				intent,
				event: JSON.stringify({
					title: { en: 'Hacked' },
					startLocal: '2030-01-01T10:00',
					endLocal: '2030-01-01T11:00',
					recurrence: { frequency: 'none' },
				}),
			})
			expect({ intent, status: refused.status }).toEqual({
				intent,
				status: 400,
			})
			expect(await refused.json()).toMatchObject({ error: 'imported_event' })
		}
		const [kept] = await db
			.select()
			.from(SiteEvent)
			.where(eq(SiteEvent.id, row.id))
		expect(kept!.title).toBe(row.title)
	})

	it('refuses a photo or link that is not https or a page of the site', async () => {
		const ctx = await setup()
		const { row } = await imported(ctx)
		for (const fields of [
			{ imageUrl: 'javascript:alert(1)', linkUrl: '' },
			{ imageUrl: '', linkUrl: 'javascript:alert(1)' },
			{ imageUrl: '', linkUrl: 'http://plain.example/x' },
		]) {
			const response = await editor(ctx, row.id, {
				intent: 'save-imported',
				linkLabel: '',
				visible: 'true',
				...fields,
			})
			expect(response.status).toBe(400)
		}
	})

	it('a sync after the operator hid it and added a photo leaves both alone', async () => {
		const ctx = await setup()
		const { source, row } = await imported(ctx)
		await editor(ctx, row.id, {
			intent: 'save-imported',
			imageUrl: 'https://cdn.example/quiz.jpg',
			linkUrl: '',
			linkLabel: '',
			visible: 'false',
		})
		feedText.current = feed('Quiz renamed')
		expect(
			(await list(ctx, { intent: 'sync-calendar', sourceId: source.id }))
				.status,
		).toBe(200)
		const [after] = await db
			.select()
			.from(SiteEvent)
			.where(eq(SiteEvent.id, row.id))
		expect(titleEn(after!.title)).toBe('Quiz renamed')
		expect(after).toMatchObject({
			status: 'draft',
			imageUrl: 'https://cdn.example/quiz.jpg',
		})
	})

	it('another organization cannot open or change it', async () => {
		const ctx = await setup()
		const { row } = await imported(ctx)
		const other = await setup()
		const response = await callAction(editorAction, {
			url: `${base(other)}/${row.id}`,
			cookie: other.cookie,
			params: { orgSlug: other.organization.slug, eventId: row.id },
			fields: {
				intent: 'save-imported',
				imageUrl: '',
				linkUrl: '',
				linkLabel: '',
				visible: 'false',
			},
		})
		expect(response.status).toBe(404)
	})
})
