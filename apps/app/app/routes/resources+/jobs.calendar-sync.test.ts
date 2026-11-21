import { db, eq, SiteEventCalendarSource } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import { action } from './jobs.calendar-sync.ts'

const sync = vi.hoisted(() => ({
	syncCalendarSource: vi.fn(async () => ({
		ok: true,
		report: { created: 0, updated: 0, removed: 0, kept: 0, skipped: 0 },
	})),
	syncDueCalendars: vi.fn(async () => ({ due: 2, synced: 2, failed: 0 })),
}))
vi.mock('#app/utils/events/calendar-sync.server.ts', () => sync)

function call(
	init: { method?: string; authorized?: boolean; body?: unknown } = {},
) {
	const url = new URL('http://localhost:3001/resources/jobs/calendar-sync')
	return action({
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/calendar-sync',
	}) as Promise<Response>
}

describe('jobs.calendar-sync (#319)', () => {
	it('is POST only and needs the internal token', async () => {
		expect((await call({ method: 'GET' })).status).toBe(405)
		await expect(call({ authorized: false })).rejects.toBeTruthy()
		expect(sync.syncDueCalendars).not.toHaveBeenCalled()
	})

	it('an empty body is the hourly sweep', async () => {
		const response = await call()
		expect(await response.json()).toEqual({
			success: true,
			due: 2,
			synced: 2,
			failed: 0,
		})
	})

	it('a source id is the workflow wake-up: read only if due', async () => {
		const response = await call({ body: { sourceId: 'abcdefgh1234' } })
		expect(response.status).toBe(200)
		expect(sync.syncCalendarSource).toHaveBeenCalledWith(
			'abcdefgh1234',
			{},
			{ onlyIfDue: true },
		)
	})

	it('refuses a malformed source id or body', async () => {
		expect((await call({ body: { sourceId: '../x' } })).status).toBe(400)
		const url = new URL('http://localhost:3001/resources/jobs/calendar-sync')
		const bad = (await action({
			request: new Request(url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
				body: '{not json',
			}),
			params: {},
			context: new RouterContextProvider(),
			url,
			pattern: '/resources/jobs/calendar-sync',
		})) as Response
		expect(bad.status).toBe(400)
		void db
		void eq
		void SiteEventCalendarSource
		void setOrgFlag
		void setupSeoOrganization
	})
})
