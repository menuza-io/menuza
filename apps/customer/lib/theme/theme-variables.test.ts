import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSiteTheme, FALLBACK_SITE_THEME } from './site-theme'
import {
	SITE_COLOR_SCHEMES,
	SITE_COLOR_TOKENS,
	SITE_THEME_DEFAULT_HEX,
} from './site-theme-tokens'
import {
	THEME_COLOR_VARIABLES,
	buildThemeVariables,
	radiusScale,
} from './theme-variables'

const brandCss = `html {
	--primary: oklch(0.623 0.214 259.815);
	--border: rgb(0 0 0 / 10%);
	--ring: color(display-p3 1 0 0);
	--radius: 0.5rem;
}
html.dark {
	--primary: #ff0000;
	--input: hsl(0 0% 100% / 0.15);
}`

describe('buildThemeVariables', () => {
	it('uses the defaults for every token when the theme is empty', () => {
		for (const theme of [FALLBACK_SITE_THEME, createSiteTheme({ css: '' })]) {
			const variables = buildThemeVariables(theme)
			for (const scheme of SITE_COLOR_SCHEMES) {
				expect(Object.keys(variables[scheme]).sort()).toEqual(
					[...THEME_COLOR_VARIABLES].sort(),
				)
				for (const token of SITE_COLOR_TOKENS) {
					expect(variables[scheme][`--color-${token}`]).toBe(
						SITE_THEME_DEFAULT_HEX[scheme][token],
					)
				}
			}
			expect(variables.radius).toBe(10)
			expect(variables.radii).toEqual({
				'--radius-sm': 6,
				'--radius-md': 8,
				'--radius-lg': 10,
				'--radius-xl': 14,
			})
			expect(variables.fonts).toEqual({ heading: 'Inter', body: 'Inter' })
			expect(variables.mode).toBe('system')
		}
	})

	it('overrides only the tokens the theme sets and parses', () => {
		const variables = buildThemeVariables(createSiteTheme({ css: brandCss }))
		expect(variables.light['--color-primary']).toBe('#2b7fff')
		expect(variables.dark['--color-primary']).toBe('#ff0000')
		expect(variables.light['--color-ring']).toBe(
			SITE_THEME_DEFAULT_HEX.light.ring,
		)
		expect(variables.light['--color-background']).toBe('#ffffff')
		expect(variables.dark['--color-background']).toBe('#0a0a0a')
		expect(variables.dark['--color-border']).toBe('#ffffff1a')
	})

	it('writes alpha as #rrggbbaa', () => {
		const variables = buildThemeVariables(createSiteTheme({ css: brandCss }))
		expect(variables.light['--color-border']).toBe('#0000001a')
		expect(variables.dark['--color-input']).toBe('#ffffff26')
		expect(variables.dark['--color-input']).toMatch(/^#[0-9a-f]{8}$/)
		expect(variables.light['--color-primary']).toMatch(/^#[0-9a-f]{6}$/)
	})

	it('converts the Sites radius from rem to px', () => {
		expect(buildThemeVariables(createSiteTheme({ css: brandCss })).radius).toBe(
			8,
		)
		expect(
			buildThemeVariables(createSiteTheme({ css: 'html { --radius: 12px; }' }))
				.radius,
		).toBe(12)
		expect(
			buildThemeVariables(createSiteTheme({ css: 'html { --radius: 0rem; }' }))
				.radii,
		).toEqual({
			'--radius-sm': 0,
			'--radius-md': 0,
			'--radius-lg': 0,
			'--radius-xl': 4,
		})
		expect(radiusScale(8)['--radius-sm']).toBe(4)
	})

	it('reports fonts and the forced mode', () => {
		const variables = buildThemeVariables(
			createSiteTheme({
				mode: 'dark',
				headingFont: 'lora',
				bodyFont: 'unknown',
			}),
		)
		expect(variables.fonts).toEqual({ heading: 'Lora', body: null })
		expect(variables.mode).toBe('dark')
	})
})

describe('app/global.css', () => {
	const globalCss = readFileSync(
		join(__dirname, '../../app/global.css'),
		'utf8',
	)

	function variantBlock(name: 'light' | 'dark'): string {
		const match = new RegExp(`@variant ${name} \\{([^}]*)\\}`).exec(globalCss)
		return match?.[1] ?? ''
	}

	it('declares the same defaults as the theme port', () => {
		for (const scheme of SITE_COLOR_SCHEMES) {
			const declared = Object.fromEntries(
				[
					...variantBlock(scheme).matchAll(/(--color-[a-z-]+):\s*([^;]+);/g),
				].map((match) => [match[1], match[2]?.trim()]),
			)
			expect(declared).toEqual(buildThemeVariables(FALLBACK_SITE_THEME)[scheme])
		}
	})

	it('declares the default radius scale', () => {
		for (const [name, value] of Object.entries(
			buildThemeVariables(FALLBACK_SITE_THEME).radii,
		)) {
			expect(globalCss).toContain(`${name}: ${value}px;`)
		}
	})
})
