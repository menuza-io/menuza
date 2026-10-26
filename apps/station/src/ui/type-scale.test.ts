import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Station's type scale (DESIGN.md, "Type and surface scale"). Every screen draws
 * from the same few sizes and three weights, so the same role never changes
 * size between screens. This test reads source, not the DOM: a drifting value
 * is caught where it is written.
 */
const SRC = join(import.meta.dirname, '..')

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) sources(path, out)
		else if (/\.(tsx|css)$/.test(name)) out.push(path)
	}
	return out
}

const files = sources(SRC).map((path) => ({
	name: relative(SRC, path),
	text: readFileSync(path, 'utf8'),
}))

function offenders(pattern: RegExp, allowed: (match: string) => boolean) {
	const found: string[] = []
	for (const { name, text } of files) {
		text.split('\n').forEach((line, index) => {
			for (const match of line.matchAll(pattern)) {
				if (!allowed(match[0])) found.push(`${name}:${index + 1} ${match[0]}`)
			}
		})
	}
	return found
}

describe('the Station type scale', () => {
	it('uses only the role sizes: xs, sm, base, xl, 2xl and the numeral sizes', () => {
		expect(
			offenders(
				/(?<![\w-])text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl)\b/g,
				(m) => /text-(xs|sm|base|xl|2xl|3xl|4xl)$/.test(m),
			),
		).toEqual([])
	})

	it('has no arbitrary text sizes in class names', () => {
		expect(offenders(/(?<![\w-])text-\[\d[^\]]*\]/g, () => false)).toEqual([])
	})

	it('keeps stylesheet font sizes on the scale (12, 14, 16, 20, 24px and up)', () => {
		const onScale =
			/^font-size:\s*(0\.75rem|0\.875rem|1rem|1\.25rem|1\.5rem|[2-9](\.\d+)?rem|calc\(.*|var\(.*|inherit|clamp\(.*)$/
		expect(
			offenders(/font-size:\s*[^;]+/g, (m) => onScale.test(m.trim())),
		).toEqual([])
	})

	it('uses three weights: normal, medium and semibold', () => {
		expect(
			offenders(
				/(?<![\w-])font-(thin|extralight|light|bold|extrabold|black)\b/g,
				() => false,
			),
		).toEqual([])
		expect(
			offenders(/font-weight:\s*[^;]+/g, (m) =>
				/:\s*(400|500|600|inherit|normal)$/.test(m.trim()),
			),
		).toEqual([])
	})
})
