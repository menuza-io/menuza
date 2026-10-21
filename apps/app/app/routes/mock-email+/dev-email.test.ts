import { sqliteClient } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCapturedEmails } from '#app/utils/dev-email-capture.server.ts'
import { DEV_EMAIL_CAPTURE_CREATE_SQL } from '#app/utils/dev-email-capture.shared.ts'
import { loader as viewer } from './_index.ts'
import { loader as messages } from './dev.messages.ts'
import { action as resetAction, loader as resetLoader } from './dev.reset.ts'

function args(path: string, init?: RequestInit) {
	return {
		request: new Request(`http://localhost:3001${path}`, init),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: path,
	} as never
}

async function settle(run: () => Promise<Response>) {
	try {
		return await run()
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

async function seed(
	to: string,
	subject: string,
	capturedAt: number,
	text = 'body',
) {
	await sqliteClient.execute(DEV_EMAIL_CAPTURE_CREATE_SQL)
	await sqliteClient.execute({
		sql: 'INSERT INTO __dev_email_capture (id, captured_at, to_addr, from_addr, subject, html, text, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		args: [
			crypto.randomUUID(),
			capturedAt,
			to,
			'from@example.com',
			subject,
			'<b>x</b>',
			text,
			'{}',
		],
	})
}

beforeEach(async () => {
	vi.stubEnv('MOCKS', 'true')
	vi.stubEnv('BASE_URL', 'http://localhost:3001')
	await resetCapturedEmails()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('mock-email routes without MOCKS', () => {
	it.each(['undefined', 'false', 'TRUE'])(
		'answer 404 everywhere when MOCKS is %s',
		async (value) => {
			if (value === 'undefined') vi.stubEnv('MOCKS', undefined as never)
			else vi.stubEnv('MOCKS', value)
			await seed('a@example.com', 'secret', Date.now())
			expect((await settle(() => viewer(args('/mock-email')))).status).toBe(404)
			expect(
				(await settle(() => messages(args('/mock-email/dev/messages')))).status,
			).toBe(404)
			expect(
				(
					await settle(() =>
						resetAction(args('/mock-email/dev/reset', { method: 'POST' })),
					)
				).status,
			).toBe(404)
			expect(
				(await settle(() => resetLoader(args('/mock-email/dev/reset')))).status,
			).toBe(404)
			vi.stubEnv('MOCKS', 'true')
			const listed = (await (
				await messages(args('/mock-email/dev/messages'))
			).json()) as unknown[]
			expect(listed).toHaveLength(1)
		},
	)
})

describe('mock-email routes on a deployment that is not local', () => {
	it.each([
		['an unset BASE_URL', undefined],
		['a public BASE_URL', 'https://app.example.com'],
	])('answer 404 with MOCKS=true and %s', async (_label, baseUrl) => {
		await seed('a@example.com', 'secret', Date.now())
		vi.stubEnv('BASE_URL', baseUrl as never)
		expect((await settle(() => viewer(args('/mock-email')))).status).toBe(404)
		expect(
			(await settle(() => messages(args('/mock-email/dev/messages')))).status,
		).toBe(404)
		expect(
			(
				await settle(() =>
					resetAction(args('/mock-email/dev/reset', { method: 'POST' })),
				)
			).status,
		).toBe(404)
	})

	it('answers 404 for a non-local request even on a local deployment', async () => {
		const remote = {
			request: new Request('https://app.example.com/mock-email/dev/messages'),
			params: {},
			context: new RouterContextProvider(),
			unstable_pattern: '/mock-email/dev/messages',
		} as never
		expect((await settle(() => messages(remote))).status).toBe(404)
	})
})

describe('GET /mock-email/dev/messages', () => {
	it('returns the documented record, newest first', async () => {
		await seed('kody@example.com', 'old', Date.parse('2030-01-01T10:00:00Z'))
		await seed('kody@example.com', 'new', Date.parse('2030-01-01T11:00:00Z'))
		const response = await messages(args('/mock-email/dev/messages'))
		expect(response.status).toBe(200)
		const body = (await response.json()) as Array<Record<string, unknown>>
		expect(body.map((m) => m.subject)).toEqual(['new', 'old'])
		expect(Object.keys(body[0]!).sort()).toEqual(
			[
				'capturedAt',
				'from',
				'html',
				'id',
				'meta',
				'region',
				'source',
				'subject',
				'text',
				'to',
			].sort(),
		)
		expect(body[0]).toMatchObject({
			capturedAt: '2030-01-01T11:00:00.000Z',
			source: 'app',
			region: null,
			to: 'kody@example.com',
			from: 'from@example.com',
			meta: {},
		})
	})

	it('filters by recipient and by since (ISO or milliseconds)', async () => {
		await seed('kody@example.com', 'k1', Date.parse('2030-01-01T10:00:00Z'))
		await seed('other@example.com', 'o1', Date.parse('2030-01-01T11:00:00Z'))
		await seed('kody@example.com', 'k2', Date.parse('2030-01-01T12:00:00Z'))
		const subjects = async (query: string) =>
			(
				(await (
					await messages(args(`/mock-email/dev/messages${query}`))
				).json()) as Array<{ subject: string }>
			).map((m) => m.subject)

		expect(await subjects('?to=kody@example.com')).toEqual(['k2', 'k1'])
		expect(await subjects('?to=nobody@example.com')).toEqual([])
		expect(await subjects('?since=2030-01-01T10:30:00Z')).toEqual(['k2', 'o1'])
		expect(
			await subjects(`?since=${Date.parse('2030-01-01T11:30:00Z')}`),
		).toEqual(['k2'])
		expect(
			await subjects('?to=kody@example.com&since=2030-01-01T11:30:00Z'),
		).toEqual(['k2'])
	})

	it('rejects a since it cannot read', async () => {
		const response = await messages(args('/mock-email/dev/messages?since=soon'))
		expect(response.status).toBe(400)
	})
})

describe('GET /mock-email', () => {
	it('lists subject, recipient and time as HTML with everything escaped', async () => {
		await seed(
			'kody@example.com',
			'<script>alert(1)</script>',
			Date.parse('2030-01-01T10:00:00Z'),
			'"quoted" <img src=x onerror=alert(2)>',
		)
		const response = await viewer(args('/mock-email'))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/html')
		expect(response.headers.get('content-security-policy')).toContain(
			"default-src 'none'",
		)
		const html = await response.text()
		expect(html).toContain('kody@example.com')
		expect(html).toContain('2030-01-01T10:00:00.000Z')
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
		expect(html).not.toContain('<script>')
		expect(html).not.toContain('<img')
	})

	it('says so when nothing was captured', async () => {
		expect(await (await viewer(args('/mock-email'))).text()).toContain(
			'0 messages',
		)
	})
})

describe('POST /mock-email/dev/reset', () => {
	it('clears the captured emails', async () => {
		await seed('a@example.com', 'x', Date.now())
		const response = await resetAction(
			args('/mock-email/dev/reset', { method: 'POST' }),
		)
		expect(response.status).toBe(200)
		expect(
			await (await messages(args('/mock-email/dev/messages'))).json(),
		).toEqual([])
	})

	it('refuses other methods', async () => {
		await seed('a@example.com', 'x', Date.now())
		expect(
			(await resetAction(args('/mock-email/dev/reset', { method: 'PUT' })))
				.status,
		).toBe(405)
		expect((await resetLoader(args('/mock-email/dev/reset'))).status).toBe(405)
		expect(
			(await (
				await messages(args('/mock-email/dev/messages'))
			).json()) as unknown[],
		).toHaveLength(1)
	})
})
