import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Customer app security sweep (#156, #196, #105): every route that reaches the
 * app registry checks who is asking before it touches anything else.
 *
 * - Pipeline routes (config, build callback): pipeline auth first, not the
 *   internal command token.
 * - Admin command, summary and health job: `requireInternalCommandAuth`.
 * - The Marketing page: sign-in and `read:settings:any` come before the flag and
 *   any record; its action needs `update:settings:any`.
 * - Admin: every loader and action starts with `requireUserWithPermission`.
 * - The public tap counter: rate limited before any lookup, and it never reads
 *   the visitor's address, agent or cookies beyond the limiter.
 */

const APP = path.resolve(import.meta.dirname, '../..')
const ADMIN = path.resolve(import.meta.dirname, '../../../../admin/app')

const read = (...parts: string[]) =>
	fs.readFileSync(path.join(...parts), 'utf8')

function exportedFunctionBody(source: string, name: string): string | null {
	const start = source.search(
		new RegExp(`export (async )?function ${name}\\s*\\(`),
	)
	if (start === -1) return null
	const open = source.indexOf('{', source.indexOf(')', start))
	let depth = 0
	for (let index = open; index < source.length; index += 1) {
		const char = source[index]
		if (char === '{') depth += 1
		if (char === '}') {
			depth -= 1
			if (depth === 0) return source.slice(open + 1, index)
		}
	}
	return null
}

const firstAwait = (body: string) =>
	body.match(/await\s+([A-Za-z_$][\w$.]*)\s*\(/)?.[1]

const PIPELINE: Array<[string, 'loader' | 'action', string]> = [
	['customer-app.config.ts', 'loader', 'requireCustomerAppPipelineAuth'],
	[
		'customer-app.build-callback.ts',
		'action',
		'requireCustomerAppBuildCallbackAuth',
	],
]

const INTERNAL: Array<[string, 'loader' | 'action']> = [
	['customer-app.summary.ts', 'loader'],
	['customer-apps.command.ts', 'action'],
	['jobs.customer-app-health.ts', 'action'],
]

describe('customer app guards', () => {
	it.each(PIPELINE)('%s checks %s first', (file, kind, guard) => {
		const source = read(APP, 'routes/resources+', file)
		const body = exportedFunctionBody(source, kind)
		expect(body).not.toBeNull()
		expect(firstAwait(body!)).toBe(guard)
	})

	it.each(INTERNAL)('%s checks the internal token first', (file, kind) => {
		const source = read(APP, 'routes/resources+', file)
		const body = exportedFunctionBody(source, kind)
		expect(body).not.toBeNull()
		expect(firstAwait(body!)).toBe('requireInternalCommandAuth')
	})

	it('the Marketing page checks sign-in and permission before the flag or any record', () => {
		const source = read(
			APP,
			'routes/_app+/$orgSlug_+/marketing+/customer-app.tsx',
		)
		for (const kind of ['loader', 'action'] as const) {
			const body = exportedFunctionBody(source, kind)!
			const order = [
				body.indexOf('requireUserOrganization('),
				body.indexOf('requireUserWithOrganizationPermission('),
				body.indexOf('customerAppPanelAvailable('),
				body.indexOf('loadCustomerAppView('),
			]
			expect(order.every((index) => index >= 0)).toBe(true)
			expect([...order].sort((a, b) => a - b)).toEqual(order)
		}
		const action = exportedFunctionBody(source, 'action')!
		expect(action.slice(0, 400)).toContain('UPDATE_SETTINGS_ANY')
		const loader = exportedFunctionBody(source, 'loader')!
		expect(loader.slice(0, 500)).toContain('READ_SETTINGS_ANY')
	})

	it('every Admin loader and action starts with the customer app permission', () => {
		const source = read(ADMIN, 'routes/_admin+/customer-apps.server.ts')
		for (const name of ['listLoader', 'detailLoader', 'action']) {
			const body = exportedFunctionBody(source, name)
			expect(body).not.toBeNull()
			expect(firstAwait(body!)).toBe('requireUserWithPermission')
			expect(body!.slice(0, 200)).toContain('CUSTOMER_APP_PERMISSION')
		}
		// The route files only delegate to those functions.
		for (const file of ['customer-apps.tsx', 'customer-apps_.$appId.tsx']) {
			const route = read(ADMIN, 'routes/_admin+', file)
			expect(route).not.toMatch(/CustomerApp\b.*db\./s)
		}
	})

	it('the public tap counter is rate limited before it looks anything up and stores no visitor data', () => {
		const source = read(APP, 'routes/resources+/sites.app-tap.ts')
		const body = exportedFunctionBody(source, 'action')!
		expect(body.indexOf('checkRateLimit(')).toBeGreaterThan(-1)
		expect(body.indexOf('checkRateLimit(')).toBeLessThan(
			body.indexOf('findPublishedSiteOrganization('),
		)
		expect(body).not.toMatch(/user-agent|cookie|referer/i)
	})

	it('no loader or action of the customer app ever selects a credential ciphertext', () => {
		const files = [
			'utils/customer-apps/view.server.ts',
			'utils/customer-apps/panel.server.ts',
			'utils/customer-apps/summary.server.ts',
			'utils/customer-apps/public.server.ts',
		]
		for (const file of files) {
			const source = read(APP, file)
			expect(source).not.toMatch(
				/CustomerAppCredential\.(ciphertext|payload|secret)/,
			)
		}
	})
})
