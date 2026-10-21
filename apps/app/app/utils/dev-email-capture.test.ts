import { sqliteClient } from '@repo/database'
import { sendEmail } from '@repo/email'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	installDevEmailCapture,
	resetDevEmailCaptureForTests,
} from '../../workers/dev-email-capture.ts'
import {
	listCapturedEmails,
	resetCapturedEmails,
} from './dev-email-capture.server.ts'
import {
	parseResendPayload,
	parseSince,
	RESEND_EMAILS_URL,
} from './dev-email-capture.shared.ts'

const realFetch = globalThis.fetch

/** The slice of D1 the capture uses, backed by the test database. */
const database = {
	prepare(query: string) {
		const run = (args: unknown[]) =>
			sqliteClient.execute({ sql: query, args: args as never[] })
		return {
			run: () => run([]),
			bind: (...args: unknown[]) => ({ run: () => run(args) }),
		}
	},
} as unknown as D1Database

const passthrough = vi.fn(async () => new Response('real', { status: 200 }))

function sendToResend(body: unknown, headers: Record<string, string> = {}) {
	return globalThis.fetch(RESEND_EMAILS_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

beforeEach(async () => {
	vi.stubEnv('MOCKS', 'true')
	globalThis.fetch = passthrough as unknown as typeof fetch
	passthrough.mockClear()
	resetDevEmailCaptureForTests()
	installDevEmailCapture({ DB: database })
	await resetCapturedEmails()
})

afterEach(() => {
	globalThis.fetch = realFetch
	vi.unstubAllEnvs()
	resetDevEmailCaptureForTests()
})

describe('dev email capture wrapper', () => {
	it('stores a Resend email and answers with a Resend-shaped success', async () => {
		const response = await sendToResend({
			from: 'Support <support@example.com>',
			to: 'kody@example.com',
			subject: 'A large-party request is waiting',
			html: '<p>Hello</p>',
			text: 'Hello',
			tags: [{ name: 'orgId', value: 'org_1' }],
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as { id: string }
		expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(passthrough).not.toHaveBeenCalled()

		const [message] = await listCapturedEmails()
		expect(message).toMatchObject({
			id: body.id,
			source: 'app',
			region: null,
			to: 'kody@example.com',
			from: 'Support <support@example.com>',
			subject: 'A large-party request is waiting',
			html: '<p>Hello</p>',
			text: 'Hello',
			meta: { tags: { orgId: 'org_1' } },
		})
		expect(new Date(message!.capturedAt).toISOString()).toBe(
			message!.capturedAt,
		)
	})

	it('keeps every recipient of a multi-recipient email', async () => {
		await sendToResend({ to: ['a@example.com', 'b@example.com'], subject: 's' })
		expect(
			(await listCapturedEmails({ to: 'B@example.com' })).map((m) => m.to),
		).toEqual(['a@example.com,b@example.com'])
	})

	it('also captures a call made with a Request object', async () => {
		await globalThis.fetch(
			new Request(RESEND_EMAILS_URL, {
				method: 'POST',
				body: JSON.stringify({ to: 'r@example.com', subject: 'via request' }),
			}),
		)
		expect((await listCapturedEmails()).map((m) => m.subject)).toEqual([
			'via request',
		])
	})

	it('answers 422 and stores nothing for a body that is not an object', async () => {
		const response = await sendToResend(['nope'])
		expect(response.status).toBe(422)
		expect(await listCapturedEmails()).toEqual([])
	})

	it('passes every other URL and method through untouched', async () => {
		await globalThis.fetch('https://api.resend.com/domains')
		await globalThis.fetch('https://example.com/emails', { method: 'POST' })
		await globalThis.fetch(RESEND_EMAILS_URL, { method: 'GET' })
		expect(passthrough).toHaveBeenCalledTimes(3)
		expect(await listCapturedEmails()).toEqual([])
	})

	it('is not installed without MOCKS=true', async () => {
		vi.stubEnv('MOCKS', 'false')
		resetDevEmailCaptureForTests()
		globalThis.fetch = passthrough as unknown as typeof fetch
		installDevEmailCapture({ DB: database })
		expect(globalThis.fetch).toBe(passthrough)
	})

	it('is not installed in a production build even with MOCKS=true', async () => {
		vi.stubEnv('PROD', true)
		resetDevEmailCaptureForTests()
		globalThis.fetch = passthrough as unknown as typeof fetch
		installDevEmailCapture({ DB: database })
		expect(globalThis.fetch).toBe(passthrough)
	})
})

describe('App sendEmail with the capture installed', () => {
	it('lands in the capture and reports success', async () => {
		const result = await sendEmail({
			to: 'kody@example.com',
			subject: '2 large-party requests are waiting',
			html: '<p>Open Today</p>',
			text: 'Open Today',
			tags: { orgId: 'org_1' },
		})
		expect(result.status).toBe('success')
		const [message] = await listCapturedEmails({ to: 'kody@example.com' })
		expect(message).toMatchObject({
			subject: '2 large-party requests are waiting',
			text: 'Open Today',
			meta: { tags: { orgId: 'org_1' } },
		})
		expect(result.status === 'success' && result.data.id).toBe(message!.id)
		expect(passthrough).not.toHaveBeenCalled()
	})
})

describe('captured email queries', () => {
	it('returns newest first and filters by recipient and since', async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date('2030-01-01T10:00:00Z'))
			await sendToResend({ to: 'a@example.com', subject: 'first' })
			vi.setSystemTime(new Date('2030-01-01T11:00:00Z'))
			await sendToResend({ to: 'b@example.com', subject: 'second' })
			vi.setSystemTime(new Date('2030-01-01T12:00:00Z'))
			await sendToResend({ to: 'a@example.com', subject: 'third' })
		} finally {
			vi.useRealTimers()
		}
		const subjects = async (
			filters: Parameters<typeof listCapturedEmails>[0],
		) => (await listCapturedEmails(filters)).map((m) => m.subject)

		expect(await subjects({})).toEqual(['third', 'second', 'first'])
		expect(await subjects({ to: 'A@example.com' })).toEqual(['third', 'first'])
		expect(await subjects({ to: 'example.com' })).toEqual([])
		expect(
			await subjects({ since: Date.parse('2030-01-01T10:30:00Z') }),
		).toEqual(['third', 'second'])
		expect(await subjects({ limit: 1 })).toEqual(['third'])
	})

	it('clears everything on reset', async () => {
		await sendToResend({ to: 'a@example.com', subject: 'x' })
		await resetCapturedEmails()
		expect(await listCapturedEmails()).toEqual([])
	})
})

describe('payload and since parsing', () => {
	it('reads epoch milliseconds and ISO dates, and rejects nonsense', () => {
		expect(parseSince('1700000000000')).toBe(1_700_000_000_000)
		expect(parseSince('2030-01-01T00:00:00Z')).toBe(
			Date.parse('2030-01-01T00:00:00Z'),
		)
		expect(parseSince('soon')).toBeNull()
		expect(parseSince('  ')).toBeNull()
	})

	it('ignores tags that are not name and value strings', () => {
		expect(
			parseResendPayload({
				to: 'a@example.com',
				tags: [{ name: 'a', value: 'b' }, { name: 1 }, null],
			})?.meta,
		).toEqual({ tags: { a: 'b' } })
		expect(parseResendPayload('x')).toBeNull()
	})
})
