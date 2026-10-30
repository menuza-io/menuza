import { applySiteTheme } from './apply-theme'
import { FALLBACK_SITE_THEME, createSiteTheme } from './site-theme'

describe('applySiteTheme', () => {
	it('pushes colors and radii for both themes into Uniwind, then sets the mode', () => {
		const { Uniwind } = jest.requireMock<{
			Uniwind: { updateCSSVariables: jest.Mock; setTheme: jest.Mock }
		}>('uniwind')
		const { updateCSSVariables, setTheme } = Uniwind
		updateCSSVariables.mockClear()
		setTheme.mockClear()

		const variables = applySiteTheme(FALLBACK_SITE_THEME)

		expect(updateCSSVariables).toHaveBeenCalledTimes(2)
		expect(updateCSSVariables).toHaveBeenCalledWith('light', {
			...variables.light,
			...variables.radii,
		})
		expect(updateCSSVariables).toHaveBeenCalledWith('dark', {
			...variables.dark,
			...variables.radii,
		})
		expect(setTheme).toHaveBeenCalledWith('system')
	})

	it('accepts an injected runtime and forces the organization mode', () => {
		const runtime = { updateCSSVariables: jest.fn(), setTheme: jest.fn() }
		applySiteTheme(
			createSiteTheme({
				mode: 'dark',
				css: 'html.dark { --primary: #ff0000; }',
			}),
			runtime,
		)
		expect(runtime.updateCSSVariables).toHaveBeenCalledWith(
			'dark',
			expect.objectContaining({
				'--color-primary': '#ff0000',
				'--radius-lg': 10,
			}),
		)
		expect(runtime.setTheme).toHaveBeenCalledWith('dark')
	})
})
