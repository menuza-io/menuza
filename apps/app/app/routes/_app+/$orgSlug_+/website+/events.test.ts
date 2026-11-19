/**
 * Website, Events (#184): the editor's rules and what the public site gets
 * from `/resources/sites/events` (next occurrences in local time across DST,
 * skipped dates, finished events, 410 after 30 days, the experience button).
 */
import { db, eq, OrganizationLocation, SiteEvent } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { loader as publicEvents } from '#app/routes/resources+/sites.events.ts'
import { buildPublicEventsPayload } from '#app/utils/seo/site-events.server.ts'
import {
	callAction,
	callLoader,
	setOrgFlag,
	setupSeoOrganization,
} from '#tests/seo-utils.ts'
import { action as editorAction } from './events.$eventId.tsx'
import { action as listAction } from './events._index.tsx'

async function setup() {
	const ctx = await setupSeoOrganization()
	await setOrgFlag(ctx.organization.id, 'website.events', true)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: ctx.organization.id,
			name: 'Downtown',
			slug: 'downtown',
			timezone: 'America/New_York',
		})
		.returning({ id: OrganizationLocation.id })
	return { ...ctx, locationId: location!.id }
}

async function createEvent(ctx: Awaited<ReturnType<typeof setup>>) {
	const response = await callAction(listAction, {
		url: `http://localhost:3000/${ctx.organization.slug}/website/events?index`,
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug },
		fields: { intent: 'create-event' },
	})
	expect(response.status).toBe(302)
	return response.headers.get('Location')!.split('/').pop()!
}

function save(
	ctx: Awaited<ReturnType<typeof setup>>,
	eventId: string,
	event: Record<string, unknown>,
	intent = 'publish-event',
) {
	return callAction(editorAction, {
		url: `http://localhost:3000/${ctx.organization.slug}/website/events/${eventId}`,
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug, eventId },
		fields: { intent, event: JSON.stringify(event) },
	})
}

const trivia = (locationId: string, extra: Record<string, unknown> = {}) => ({
	title: { en: 'Trivia night' },
	description: { en: 'Teams of four.' },
	slug: 'trivia',
	locationId,
	startLocal: '2026-10-20T20:00',
	endLocal: '2026-10-20T22:30',
	recurrence: { frequency: 'weekly', weekdays: [2], interval: 1 },
	exceptions: { skipped: [], moved: [] },
	...extra,
})

describe('website events (#184)', () => {
	it('a weekly event shows its next occurrences at 20:00 local across the DST change', async () => {
		const ctx = await setup()
		const id = await createEvent(ctx)
		expect((await save(ctx, id, trivia(ctx.locationId))).status).toBe(200)
		const { events } = await buildPublicEventsPayload(
			{ id: ctx.organization.id, siteDefaultLocale: 'en' },
			{ now: new Date('2026-10-25T00:00:00Z') },
		)
		expect(events).toHaveLength(1)
		expect(events[0]!.timezone).toBe('America/New_York')
		expect(events[0]!.occurrences.slice(0, 3).map((o) => o.start)).toEqual([
			'2026-10-27T20:00:00-04:00',
			'2026-11-03T20:00:00-05:00',
			'2026-11-10T20:00:00-05:00',
		])
	})

	it('skipping one date hides only that occurrence', async () => {
		const ctx = await setup()
		const id = await createEvent(ctx)
		await save(
			ctx,
			id,
			trivia(ctx.locationId, {
				exceptions: { skipped: ['2026-11-03'], moved: [] },
			}),
		)
		const { events } = await buildPublicEventsPayload(
			{ id: ctx.organization.id, siteDefaultLocale: 'en' },
			{ now: new Date('2026-10-25T00:00:00Z') },
		)
		expect(events[0]!.occurrences.slice(0, 3).map((o) => o.date)).toEqual([
			'2026-10-27',
			'2026-11-10',
			'2026-11-17',
		])
	})

	it('refuses an end before the start or longer than a day, and unsafe links', async () => {
		const ctx = await setup()
		const id = await createEvent(ctx)
		const backwards = await save(
			ctx,
			id,
			trivia(ctx.locationId, { endLocal: '2026-10-20T19:00' }),
		)
		expect(backwards.status).toBe(400)
		expect(await backwards.json()).toMatchObject({
			error: 'invalid_event_time',
		})
		const long = await save(
			ctx,
			id,
			trivia(ctx.locationId, { endLocal: '2026-10-21T21:00' }),
		)
		expect(await long.json()).toMatchObject({ error: 'invalid_event_time' })
		const link = await save(
			ctx,
			id,
			trivia(ctx.locationId, { linkUrl: 'javascript:alert(1)' }),
		)
		expect(await link.json()).toMatchObject({ error: 'invalid_link' })
	})

	it('a finished event leaves the list, its page says it ended, then answers 410', async () => {
		const ctx = await setup()
		const id = await createEvent(ctx)
		await save(
			ctx,
			id,
			trivia(ctx.locationId, {
				slug: 'brunch',
				startLocal: '2026-10-04T11:00',
				endLocal: '2026-10-04T14:00',
				recurrence: { frequency: 'none' },
			}),
		)
		const org = { id: ctx.organization.id, siteDefaultLocale: 'en' }
		const after = new Date('2026-10-10T00:00:00Z')
		expect(
			(await buildPublicEventsPayload(org, { now: after })).events,
		).toEqual([])
		const page = await buildPublicEventsPayload(org, {
			now: after,
			eventSlug: 'brunch',
		})
		expect(page.events[0]).toMatchObject({ phase: 'ended', occurrences: [] })
		const gone = await buildPublicEventsPayload(org, {
			now: new Date('2026-11-04T00:00:00Z'),
			eventSlug: 'brunch',
		})
		expect(gone.events[0]!.phase).toBe('gone')
	})

	it('unpublishing removes the event from the site at once', async () => {
		const ctx = await setup()
		const id = await createEvent(ctx)
		await save(ctx, id, trivia(ctx.locationId))
		const response = await callAction(editorAction, {
			url: `http://localhost:3000/${ctx.organization.slug}/website/events/${id}`,
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug, eventId: id },
			fields: { intent: 'unpublish-event' },
		})
		expect(response.status).toBe(200)
		const [row] = await db
			.select({ status: SiteEvent.status })
			.from(SiteEvent)
			.where(eq(SiteEvent.id, id))
		expect(row!.status).toBe('draft')
		const publicResponse = (await callLoader(publicEvents, {
			url: `http://localhost/resources/sites/events?slug=${ctx.organization.slug}`,
		})) as Response
		expect(
			((await publicResponse.json()) as { events: unknown[] }).events,
		).toEqual([])
	})

	it('shows an experience booking button only while online booking is on', async () => {
		const ctx = await setup()
		const id = await createEvent(ctx)
		await save(
			ctx,
			id,
			trivia(ctx.locationId, { experienceId: 'wine-tasting' }),
		)
		const org = { id: ctx.organization.id, siteDefaultLocale: 'en' }
		expect(
			(await buildPublicEventsPayload(org)).events[0]!.experience,
		).toBeNull()
		await setOrgFlag(ctx.organization.id, 'reservations.enabled', true)
		await setOrgFlag(ctx.organization.id, 'reservations.online', true)
		await setOrgFlag(ctx.organization.id, 'reservations.experiences', true)
		expect((await buildPublicEventsPayload(org)).events[0]!.experience).toEqual(
			{
				id: 'wine-tasting',
			},
		)
	})

	it('is off by default: the editor 404s and the public endpoint 404s', async () => {
		const ctx = await setupSeoOrganization()
		const response = await callAction(listAction, {
			url: `http://localhost:3000/${ctx.organization.slug}/website/events?index`,
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
			fields: { intent: 'create-event' },
		})
		expect(response.status).toBe(404)
		const publicResponse = (await callLoader(publicEvents, {
			url: `http://localhost/resources/sites/events?slug=${ctx.organization.slug}`,
		})) as Response
		expect(publicResponse.status).toBe(404)
	})

	it("refuses another organization's event", async () => {
		const ctx = await setup()
		const other = await setup()
		const id = await createEvent(other)
		const response = await save(ctx, id, trivia(ctx.locationId))
		expect(response.status).toBe(404)
	})
})
