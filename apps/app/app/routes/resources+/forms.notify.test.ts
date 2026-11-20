import {
	db,
	eq,
	FormAlertDigest,
	Notification,
	NotificationPreference,
	Organization,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const sendEmailMock = vi.hoisted(() => vi.fn())

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import {
	deliverFormResponseAlert,
	flushFormAlertDigests,
} from '#app/utils/forms/alerts.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { action } from './forms.notify.ts'

/**
 * `POST /resources/forms/notify` (#142): a region tells the App a website form
 * got a response. Ids and a count only; an in-app notification per response
 * and email batched to one per form per member every 10 minutes.
 */

async function ready(organizationId: string) {
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	return action({
		request: new Request('http://localhost:3001/resources/forms/notify', {
			method: options.method ?? 'POST',
			headers: {
				'content-type': 'application/json',
				...(options.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
			},
			body:
				options.method === 'GET'
					? undefined
					: typeof body === 'string'
						? body
						: JSON.stringify(body),
		}),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/forms/notify',
	} as never)
}

let sequence = 0
const event = (orgId: string, overrides: Record<string, unknown> = {}) => ({
	orgId,
	eventId: `evt${(sequence += 1)}`,
	formId: 'form1',
	formName: 'Catering enquiry',
	count: 1,
	at: Date.UTC(2026, 10, 20, 12, 0, 0),
	notify: { mode: 'all' as const },
	restricted: false,
	...overrides,
})

const notificationsFor = (userId: string) =>
	db.select().from(Notification).where(eq(Notification.userId, userId))

beforeEach(async () => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
	// The sweep is global: start every test without earlier digests.
	await db.delete(FormAlertDigest)
})

describe('POST /resources/forms/notify', () => {
	it('answers 401 without the internal token and does nothing', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const response = await call(event(organization.id), { authorized: false })
		expect(response.status).toBe(401)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('is a POST route only', async () => {
		expect((await call({}, { method: 'GET' })).status).toBe(405)
	})

	it.each([
		['an answer', { values: { name: 'Rana' } }],
		['a contact', { email: 'rana@example.com' }],
		['a bad count', { count: 0 }],
	])('rejects an event with %s, without echoing it', async (_label, patch) => {
		const { organization } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const response = await call({ ...event(organization.id), ...patch })
		expect(response.status).toBe(400)
		const text = await response.text()
		expect(text).not.toContain('Rana')
		expect(text).not.toContain('rana@example.com')
	})

	it('answers 404 for an organization that does not exist', async () => {
		expect((await call(event('clw9x0a12000008l00nobody'))).status).toBe(404)
	})

	it('creates an in-app notification with no response values', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const response = await call(event(organization.id))
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ inApp: 1 })
		const [row] = await notificationsFor(user.id)
		expect(row).toMatchObject({ type: 'form-response' })
		expect(JSON.parse(String(row!.payload))).toEqual({
			orgSlug: organization.slug,
			formId: 'form1',
			formName: 'Catering enquiry',
			kind: 'form_response',
			count: 1,
		})
	})

	it('does not notify twice for a redelivered event', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const same = event(organization.id)
		await call(same)
		const again = await call(same)
		expect(await again.json()).toMatchObject({ inApp: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
	})

	it('notifies only the members chosen in the form settings', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const response = await call(
			event(organization.id, {
				notify: { mode: 'members', userIds: ['somebodyelse'] },
			}),
		)
		expect(await response.json()).toMatchObject({ skipped: 'no_recipients' })
		expect(await notificationsFor(user.id)).toHaveLength(0)
		const chosen = await call(
			event(organization.id, {
				notify: { mode: 'members', userIds: [user.id] },
			}),
		)
		expect(await chosen.json()).toMatchObject({ inApp: 1 })
	})

	it('respects a member who turned in-app or email off', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		await db.insert(NotificationPreference).values({
			userId: user.id,
			organizationId: organization.id,
			workflow: 'form-response-workflow',
			inApp: false,
			email: false,
		})
		const response = await call(event(organization.id))
		expect(await response.json()).toMatchObject({ inApp: 0, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})
})

describe('email batching: one per form per member every 10 minutes', () => {
	const T0 = new Date(Date.UTC(2026, 10, 20, 12, 0, 0))
	const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
	const deps = (now: Date) => ({ now: () => now, sendEmail: sendEmailMock })

	async function setup() {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		return { organization, user }
	}
	const org = (o: { id: string; slug: string }) => ({ id: o.id, slug: o.slug })
	const subjects = () =>
		sendEmailMock.mock.calls.map((call) => String(call[0].subject))

	it('sends the first response at once and counts the next ones for later', async () => {
		const { organization } = await setup()
		const send = (minutes: number) =>
			deliverFormResponseAlert(
				event(organization.id) as never,
				org(organization),
				deps(at(minutes)),
			)
		expect(await send(0)).toMatchObject({ inApp: 1, emailed: 1 })
		expect(await send(2)).toMatchObject({ inApp: 1, emailed: 0 })
		expect(await send(5)).toMatchObject({ inApp: 1, emailed: 0 })
		expect(subjects()).toEqual(['New response to Catering enquiry'])
		// Past the window, the next response carries the two it waited behind.
		expect(await send(11)).toMatchObject({ emailed: 1 })
		expect(subjects()).toEqual([
			'New response to Catering enquiry',
			'3 new responses to Catering enquiry',
		])
		const [digest] = await db
			.select()
			.from(FormAlertDigest)
			.where(eq(FormAlertDigest.organizationId, organization.id))
		expect(digest).toMatchObject({ pendingCount: 0 })
	})

	it('batches per form: another form is not held back', async () => {
		const { organization } = await setup()
		const send = (formId: string, minutes: number) =>
			deliverFormResponseAlert(
				event(organization.id, { formId, formName: formId }) as never,
				org(organization),
				deps(at(minutes)),
			)
		await send('menu', 0)
		expect(await send('jobs', 1)).toMatchObject({ emailed: 1 })
		expect(await send('menu', 2)).toMatchObject({ emailed: 0 })
	})

	it('the sweep sends the waiting count once the window has passed', async () => {
		const { organization } = await setup()
		const send = (minutes: number) =>
			deliverFormResponseAlert(
				event(organization.id) as never,
				org(organization),
				deps(at(minutes)),
			)
		await send(0)
		await send(3)
		await send(4)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(await flushFormAlertDigests(deps(at(6)))).toEqual({ emailed: 0 })
		expect(await flushFormAlertDigests(deps(at(12)))).toEqual({ emailed: 1 })
		expect(subjects().at(-1)).toBe('2 new responses to Catering enquiry')
		// Nothing left to send.
		expect(await flushFormAlertDigests(deps(at(30)))).toEqual({ emailed: 0 })
	})

	it('a failed send is retried by the next response, not lost', async () => {
		const { organization } = await setup()
		sendEmailMock.mockResolvedValueOnce({ status: 'error' })
		const send = (minutes: number) =>
			deliverFormResponseAlert(
				event(organization.id) as never,
				org(organization),
				deps(at(minutes)),
			)
		expect(await send(0)).toMatchObject({ emailed: 0 })
		expect(await send(1)).toMatchObject({ emailed: 1 })
		expect(subjects().at(-1)).toBe('2 new responses to Catering enquiry')
	})

	it('never puts an answer in the email', async () => {
		const { organization } = await setup()
		await deliverFormResponseAlert(
			event(organization.id, { restricted: true }) as never,
			org(organization),
			deps(at(0)),
		)
		const mail = JSON.stringify(sendEmailMock.mock.calls[0]![0].subject)
		expect(mail).toBe('"New response to Catering enquiry"')
	})
})
