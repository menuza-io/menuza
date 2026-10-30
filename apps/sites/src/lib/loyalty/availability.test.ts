// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loyaltyProgramAvailable, revealLoyaltyLinks } from './availability.ts'
import { testProgram } from './test-fixtures.ts'

function fakeFetch(answer: () => Response) {
	return vi.fn<typeof fetch>(async () => answer())
}

afterEach(() => {
	document.body.replaceChildren()
})

describe('loyaltyProgramAvailable', () => {
	it('asks the region anonymously, with the site binding', async () => {
		const fetchImpl = fakeFetch(() => Response.json({ program: testProgram() }))
		await expect(
			loyaltyProgramAvailable({
				fetchImpl,
				baseUrl: () => 'https://us.api.test/',
				binding: () => ({ slug: 'acme' }),
			}),
		).resolves.toBe(true)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const [url, init] = fetchImpl.mock.calls[0]!
		expect(url).toBe('https://us.api.test/loyalty/program?slug=acme')
		const headers = new Headers(init?.headers)
		expect(headers.get('X-Client')).toBe('web')
		expect(headers.get('Authorization')).toBeNull()
	})

	it('says no when loyalty is off, the region refuses, the answer is broken or the network fails', async () => {
		const answers: Array<() => Response> = [
			() => Response.json({ program: null }),
			() => Response.json({ error: 'unavailable' }, { status: 503 }),
			() => new Response('not json', { status: 200 }),
			() => {
				throw new TypeError('offline')
			},
		]
		for (const answer of answers) {
			await expect(
				loyaltyProgramAvailable({
					fetchImpl: fakeFetch(answer),
					baseUrl: () => 'https://us.api.test',
					binding: () => ({}),
				}),
			).resolves.toBe(false)
		}
	})

	it('says no without asking when the page names no region', async () => {
		const fetchImpl = fakeFetch(() => Response.json({ program: testProgram() }))
		await expect(
			loyaltyProgramAvailable({
				fetchImpl,
				baseUrl: () => {
					throw new Error('no region')
				},
				binding: () => ({}),
			}),
		).resolves.toBe(false)
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

describe('revealLoyaltyLinks', () => {
	function hiddenLinks() {
		document.body.innerHTML =
			'<a data-loyalty-link hidden href="/profile/rewards">Rewards</a><div data-loyalty-link hidden></div>'
		return Array.from(
			document.querySelectorAll<HTMLElement>('[data-loyalty-link]'),
		)
	}

	it('shows the links once the region says the program exists', async () => {
		const links = hiddenLinks()
		await revealLoyaltyLinks(document, async () => true)
		expect(links.map((link) => link.hidden)).toEqual([false, false])
	})

	it('keeps them hidden otherwise', async () => {
		const links = hiddenLinks()
		await revealLoyaltyLinks(document, async () => false)
		expect(links.map((link) => link.hidden)).toEqual([true, true])
	})

	it('does not ask when no link is hidden', async () => {
		document.body.innerHTML =
			'<a data-loyalty-link href="/profile/rewards">Rewards</a>'
		const isAvailable = vi.fn(async () => true)
		await revealLoyaltyLinks(document, isAvailable)
		expect(isAvailable).not.toHaveBeenCalled()
	})
})
