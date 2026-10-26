import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8')

describe('published restaurant radius', () => {
	it.each(['control', 'group', 'panel', 'inset'])(
		'passes the %s radius through without scaling or capping',
		(role) => {
			expect(css).toMatch(
				new RegExp(`--station-${role}-radius:\\s*var\\(--radius\\)\\s*;`),
			)
		},
	)
})
