import { db, eq, Organization, SetupReminder } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action as jobAction } from './jobs.setup-reminders.ts'
import { action } from './setup-reminder.ts'

vi.mock('#app/utils/menu/menu-health.server.ts', () => ({
	loadMenuHealth: vi.fn(async () => ({
		score: 75,
		grade: 'C',
		fixCount: 0,
		checks: [],
		itemCount: 5,
		staleDismissals: [],
	})),
}))

function args(
	path: string,
	options: { method?: string; token?: string | null; body?: unknown },
) {
	const url = new URL(`http://localhost:3001${path}`)
	return {
		request: new Request(url, {
			method: options.method ?? 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(options.token === null
					? {}
					: {
							Authorization: `Bearer ${options.token ?? ENV.INTERNAL_COMMAND_TOKEN}`,
						}),
			},
			...(options.method === 'GET'
				? {}
				: { body: JSON.stringify(options.body ?? {}) }),
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: path,
	}
}

describe('the setup reminder job route (#271)', () => {
	it('needs the internal command token and only answers POST', async () => {
		await expect(
			jobAction(args('/resources/jobs/setup-reminders', { token: null })),
		).rejects.toMatchObject({ status: 401 })
		const get = await jobAction(
			args('/resources/jobs/setup-reminders', { method: 'GET' }),
		)
		expect(get.status).toBe(405)
	})

	it('runs and answers with counts only', async () => {
		const response = await jobAction(
			args('/resources/jobs/setup-reminders', {}),
		)
		expect(response.status).toBe(200)
		const body = (await response.json()) as Record<string, unknown>
		expect(body).toMatchObject({ success: true })
		for (const key of ['checked', 'sent', 'skipped', 'reset', 'excluded']) {
			expect(typeof body[key]).toBe('number')
		}
		expect(JSON.stringify(body)).not.toContain('@')
	})
})

describe("Admin's setup reminder command (#271)", () => {
	it('needs the internal command token', async () => {
		const response = await action(
			args('/resources/setup-reminder', {
				token: null,
				body: { intent: 'preview', organizationId: 'x' },
			}),
		)
		expect(response.status).toBe(401)
	})

	it('refuses a body that is not a preview or send', async () => {
		const response = await action(
			args('/resources/setup-reminder', { body: { intent: 'delete' } }),
		)
		expect(response.status).toBe(400)
		const noAdmin = await action(
			args('/resources/setup-reminder', {
				body: { intent: 'send', organizationId: 'x' },
			}),
		)
		expect(noAdmin.status).toBe(400)
	})

	it('says there is nothing to remind about for an organization without the checklist', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const response = await action(
			args('/resources/setup-reminder', {
				body: { intent: 'preview', organizationId: organization.id },
			}),
		)
		const body = (await response.json()) as { status: string }
		// The launch checklist flag is off: no step to name.
		expect(body.status).toBe('checklist_off')
	})

	it('answers an unknown organization without sending anything or writing a row', async () => {
		const admin = await createTestUser()
		const response = await action(
			args('/resources/setup-reminder', {
				body: {
					intent: 'send',
					organizationId: 'no-such-organization',
					adminUserId: admin.id,
				},
			}),
		)
		expect(await response.json()).toEqual({ status: 'nothing_to_remind' })
		expect(
			await db
				.select()
				.from(SetupReminder)
				.where(eq(SetupReminder.organizationId, 'no-such-organization')),
		).toEqual([])
		void Organization
	})
})
