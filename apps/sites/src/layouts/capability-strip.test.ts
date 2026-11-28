/** @vitest-environment jsdom */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The layout's inline script moves a `#test=` code and a `#join=` token out of
 * the address bar before any analytics tag loads (#119, #170). It is plain
 * script in an Astro file, so the test pulls its text out and runs it.
 */
const source = fs.readFileSync(
	path.join(import.meta.dirname, 'SiteLayout.astro'),
	'utf8',
)
const script = [...source.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)]
	.map((match) => match[1]!)
	.find((text) => text.includes('menuza_pending_join'))!

function run() {
	// eslint-disable-next-line no-new-func
	new Function(script)()
}

beforeEach(() => {
	sessionStorage.clear()
	window.history.replaceState(null, '', '/menu/group')
})

describe('the capability stripper in the layout', () => {
	it('parks a test code and a join token in session storage and cleans the bar', () => {
		window.history.replaceState(
			null,
			'',
			'/menu/group?g=g1#a=1&join=gs1.abc&test=t1.code',
		)
		run()
		expect(window.location.hash).toBe('#a=1')
		expect(window.location.search).toBe('?g=g1')
		expect(sessionStorage.getItem('menuza_pending_join')).toBe('gs1.abc')
		expect(sessionStorage.getItem('menuza_pending_test')).toBe('t1.code')
	})

	it('leaves other fragments alone', () => {
		window.history.replaceState(null, '', '/menu#section')
		run()
		expect(window.location.hash).toBe('#section')
		expect(sessionStorage.getItem('menuza_pending_join')).toBeNull()
	})

	it('still cleans the bar when storage refuses the write', () => {
		const original = Storage.prototype.setItem
		Storage.prototype.setItem = () => {
			throw new Error('blocked')
		}
		try {
			window.history.replaceState(null, '', '/menu#test=t1.code')
			run()
			expect(window.location.hash).toBe('')
		} finally {
			Storage.prototype.setItem = original
		}
	})
})
