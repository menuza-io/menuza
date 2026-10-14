import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLivePosting, resetJobPostingCache } from './job-posting-context.ts'

const ORG = 'clw9x0a12000008l00staffa'
const posting = {
	id: 'p1',
	slug: 'line-cook',
	title: 'Line cook',
	positionName: 'Line cook',
	scopeIds: ['loc-1'],
	questions: [
		{
			id: 'a',
			kind: 'yes_no',
			prompt: 'Weekends?',
			dealbreaker: true,
			requiredAnswer: 'yes',
		},
		{ id: 'bad', kind: 'nonsense' },
	],
}

describe('getLivePosting', () => {
	beforeEach(() => {
		resetJobPostingCache()
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('asks the App with the internal token and returns the live posting', async () => {
		const fetchMock = vi.fn(async () => Response.json({ orgId: ORG, posting }))
		vi.stubGlobal('fetch', fetchMock)
		const found = await getLivePosting(ORG, 'line-cook')
		expect(found.status).toBe('found')
		if (found.status !== 'found') return
		expect(found.posting).toMatchObject({ id: 'p1', scopeIds: ['loc-1'] })
		// A damaged question is dropped rather than failing the whole posting.
		expect(found.posting.questions).toEqual([])
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe(
			`https://app.test/resources/staffing/job-posting?orgId=${ORG}&slug=line-cook`,
		)
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^Bearer test-internal/,
		)
		expect(init.redirect).toBe('error')
	})

	it('caches for a short time, and caches a miss for less', async () => {
		const fetchMock = vi.fn(async () => Response.json({ orgId: ORG, posting }))
		vi.stubGlobal('fetch', fetchMock)
		await getLivePosting(ORG, 'line-cook', 1_000)
		await getLivePosting(ORG, 'line-cook', 30_000)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await getLivePosting(ORG, 'line-cook', 70_000)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		const missing = vi.fn(async () => new Response('x', { status: 404 }))
		vi.stubGlobal('fetch', missing)
		expect((await getLivePosting(ORG, 'gone', 0)).status).toBe('not_found')
		await getLivePosting(ORG, 'gone', 10_000)
		expect(missing).toHaveBeenCalledTimes(1)
		await getLivePosting(ORG, 'gone', 20_000)
		expect(missing).toHaveBeenCalledTimes(2)
	})

	it('reports an unreachable or confused App as unavailable, never as a posting', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('x', { status: 503 })),
		)
		expect((await getLivePosting(ORG, 'line-cook')).status).toBe('unavailable')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('down')
			}),
		)
		expect((await getLivePosting(ORG, 'line-cook')).status).toBe('unavailable')
		// Another organization's or another posting's answer is not accepted.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ orgId: 'clw9x0a12000008l00staffb', posting }),
			),
		)
		expect((await getLivePosting(ORG, 'line-cook')).status).toBe('unavailable')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ orgId: ORG, posting: { ...posting, slug: 'other' } }),
			),
		)
		expect((await getLivePosting(ORG, 'line-cook')).status).toBe('unavailable')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ nope: true })),
		)
		expect((await getLivePosting(ORG, 'line-cook')).status).toBe('unavailable')
	})

	it('does not call the App without a configured token or for a malformed organization id', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		expect((await getLivePosting('../x', 'line-cook')).status).toBe('not_found')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', '')
		expect((await getLivePosting(ORG, 'line-cook')).status).toBe('unavailable')
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
