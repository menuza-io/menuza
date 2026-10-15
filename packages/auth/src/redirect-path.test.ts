import { describe, expect, it } from 'vitest'
import {
	getRequestDocumentPath,
	safeDocumentRedirect,
	toDocumentPath,
} from './redirect-path.js'

describe('toDocumentPath', () => {
	it('maps the index data path to the page', () => {
		expect(toDocumentPath('/_.data')).toBe('/')
		expect(toDocumentPath('/acme/_.data')).toBe('/acme')
	})

	it('strips the .data suffix and the _routes param', () => {
		expect(toDocumentPath('/acme/notes.data?_routes=routes%2Fnotes')).toBe(
			'/acme/notes',
		)
		expect(toDocumentPath('/acme/notes.data?q=a&_routes=x')).toBe(
			'/acme/notes?q=a',
		)
	})

	it('leaves page paths alone', () => {
		expect(toDocumentPath('/acme/settings?tab=billing')).toBe(
			'/acme/settings?tab=billing',
		)
		expect(toDocumentPath('/')).toBe('/')
	})
})

describe('getRequestDocumentPath', () => {
	it('reads the page path from a single-fetch request', () => {
		const request = new Request('https://app.test/_.data')
		expect(getRequestDocumentPath(request)).toBe('/')
	})
})

describe('safeDocumentRedirect', () => {
	it('never redirects to a data path', () => {
		expect(safeDocumentRedirect('/_.data')).toBe('/')
		expect(safeDocumentRedirect('/acme/notes.data')).toBe('/acme/notes')
	})

	it('keeps the default for unsafe targets', () => {
		expect(safeDocumentRedirect('https://evil.test', '/login')).toBe('/login')
		expect(safeDocumentRedirect('//evil.test')).toBe('/')
	})

	it('never normalizes a target into another host', () => {
		for (const to of [
			'/.//evil.test',
			'/%2e//evil.test',
			'/%2E%2E//evil.test',
			'/./\\evil.test',
			'/.//evil.test.data',
			'/./%2e/./\\/evil.test',
		]) {
			const result = safeDocumentRedirect(to, '/login')
			expect(result, to).not.toMatch(/^[/\\]{2}/)
			expect(result.startsWith('/'), to).toBe(true)
		}
	})
})
