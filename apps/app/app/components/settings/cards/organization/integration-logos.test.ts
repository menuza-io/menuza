// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const UI_PATH = resolve(process.cwd(), '../../packages/ui')
const BRAND_COLORS = [
	['google', ['#4285F4', '#34A853', '#FBBC05', '#EA4335']],
	['yelp', ['#FF1A1A']],
	['tripadvisor', ['#34E0A1']],
	['clover', ['#228800']],
	['square', ['#3E4348', '#FFFFFF']],
	['toast', ['#FF4C00']],
	['uber-eats', ['#06C167']],
	['doordash', ['#FF3008']],
	['deliveroo', ['#00CCBC']],
	['just-eat', ['#FF8000']],
	['opentable', ['#DA3743']],
] as const

function readSvg(path: string) {
	return new DOMParser().parseFromString(
		readFileSync(path, 'utf8'),
		'image/svg+xml',
	)
}

describe('integration brand logos', () => {
	it.each(BRAND_COLORS)(
		'preserves the %s brand colors in the source asset and shared sprite',
		(name, colors) => {
			const source = readSvg(resolve(UI_PATH, 'other/svg-icons', `${name}.svg`))
			const sprite = readSvg(resolve(UI_PATH, 'components/icons/sprite.svg'))
			expect(source.querySelector('parsererror')).toBeNull()
			expect(sprite.querySelector('parsererror')).toBeNull()

			const symbol = sprite.getElementById(name)
			expect(symbol).not.toBeNull()
			expect(symbol?.getAttribute('viewBox')).toBe(
				source.documentElement.getAttribute('viewBox'),
			)
			for (const color of colors) {
				const selector = `[fill="${color}"], [color="${color}"]`
				expect(source.querySelector(selector)).not.toBeNull()
				expect(symbol?.querySelector(selector)).not.toBeNull()
			}
			expect(symbol?.querySelector('path')).not.toBeNull()
		},
	)
})
