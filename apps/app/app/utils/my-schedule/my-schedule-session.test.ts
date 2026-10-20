// @vitest-environment jsdom

import { formatScheduleLinkToken } from '@repo/staffing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetLink, takeLink } from './my-schedule-session.ts'

const TOKEN = formatScheduleLinkToken('org_1', 'link-0001', 'a'.repeat(64))
const scope = (hash: string) => ({
	hash,
	pathname: '/my-schedule',
	search: '',
})

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('finding the link', () => {
	it('reads it from the address, removes it from the address bar and remembers it for this tab', () => {
		const history = { replaceState: vi.fn() }
		const found = takeLink(scope(`#r=ksa&t=${TOKEN}`), history)
		expect(found).toEqual({ region: 'ksa', token: TOKEN })
		expect(history.replaceState).toHaveBeenCalledWith(null, '', '/my-schedule')
		// A reload has no fragment any more and still works.
		expect(takeLink(scope(''), history)).toEqual({
			region: 'ksa',
			token: TOKEN,
		})
	})

	it('has nothing when there is no link anywhere', () => {
		expect(takeLink(scope(''), { replaceState: vi.fn() })).toBeNull()
	})

	it.each([
		'#',
		'#r=eu&t=x',
		'#r=us',
		'#r=us&t=not-a-token',
		`#t=${TOKEN}`,
		`#${'x'.repeat(500)}`,
	])('ignores a malformed fragment (%s) and stores nothing', (hash) => {
		const history = { replaceState: vi.fn() }
		expect(takeLink(scope(hash), history)).toBeNull()
		expect(history.replaceState).not.toHaveBeenCalled()
		expect(sessionStorage).toHaveLength(0)
	})

	it('prefers a new link over an older one in this tab', () => {
		const history = { replaceState: vi.fn() }
		takeLink(scope(`#r=us&t=${TOKEN}`), history)
		const other = formatScheduleLinkToken('org_2', 'link-0002', 'b'.repeat(64))
		expect(takeLink(scope(`#r=us&t=${other}`), history)?.token).toBe(other)
		expect(takeLink(scope(''), history)?.token).toBe(other)
	})

	it('forgets the link on request', () => {
		takeLink(scope(`#r=us&t=${TOKEN}`), { replaceState: vi.fn() })
		forgetLink()
		expect(takeLink(scope(''), { replaceState: vi.fn() })).toBeNull()
	})

	it('survives a browser that will not keep it', () => {
		// The prototype of the storage the code under test really uses: on newer
		// Node versions the global `sessionStorage` is Node's own object, not
		// jsdom's, so `Storage.prototype` would not intercept it.
		const storage = Object.getPrototypeOf(sessionStorage) as Storage
		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('blocked')
		})
		vi.spyOn(storage, 'getItem').mockImplementation(() => {
			throw new Error('blocked')
		})
		const history = { replaceState: vi.fn() }
		expect(takeLink(scope(`#r=us&t=${TOKEN}`), history)).toEqual({
			region: 'us',
			token: TOKEN,
		})
		expect(takeLink(scope(''), history)).toBeNull()
		expect(() => forgetLink()).not.toThrow()
	})

	it('still returns the link when the address cannot be rewritten', () => {
		const history = {
			replaceState: vi.fn(() => {
				throw new Error('no')
			}),
		}
		expect(takeLink(scope(`#r=us&t=${TOKEN}`), history)?.token).toBe(TOKEN)
	})
})
