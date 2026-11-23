import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = join(__dirname, '..', '..')
const read = (path: string) => readFileSync(join(app, path), 'utf8')

/**
 * Help (#233) is reachable from every signed-in page because it lives in the
 * one layout every signed-in route renders in. These guards fail if a signed-in
 * route gets a layout of its own without Help, or if the entry points go.
 */
describe('Help is reachable from every page', () => {
	it('the signed-in layout wraps every page, the sidebar and the command menu in the Help provider', () => {
		const layout = read('components/marketing-layout.tsx')
		const helpAt = layout.indexOf('<HelpProvider>')
		const paletteAt = layout.indexOf('<CommandPaletteProvider>')
		expect(helpAt).toBeGreaterThan(-1)
		// The command menu and the sidebar are rendered inside it.
		expect(helpAt).toBeLessThan(paletteAt)
		expect(layout).toContain('<AppSidebar')
		expect(layout).toContain('{children}')
	})

	it('every signed-in route is under the one layout', () => {
		const layoutRoute = read('routes/_app+/_layout.tsx')
		expect(layoutRoute).toContain('MarketingLayout')
		expect(layoutRoute).toContain('<Outlet />')
	})

	it('the account menu and the command menu both have the Help entries', () => {
		const account = read('components/nav-user.tsx')
		for (const label of [
			'Contact support',
			'Help articles',
			"What's new",
			'Report a problem',
		]) {
			expect(account).toContain(label)
		}
		const palette = read('components/command-menu.tsx')
		for (const label of ['Contact support', 'Report a problem']) {
			expect(palette).toContain(label)
		}
	})

	it('error screens and error toasts offer Get help', () => {
		expect(read('components/error-boundary.tsx')).toContain('Get help')
		expect(read('components/help/help-context.tsx')).toContain(
			'installGetHelpOnErrorToasts',
		)
	})
})
