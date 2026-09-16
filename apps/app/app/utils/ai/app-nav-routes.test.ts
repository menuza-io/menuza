import { describe, expect, it } from 'vitest'
import {
	APP_NAV_ROUTES,
	buildNavigationSystemPrompt,
	getNavigableAppRoutes,
	resolveAppNavPath,
} from './app-nav-routes.ts'

describe('app nav routes', () => {
	it('uses unique ids and path templates that start with /', () => {
		const ids = APP_NAV_ROUTES.map((route) => route.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const route of APP_NAV_ROUTES) {
			expect(route.path.startsWith('/')).toBe(true)
			expect(route.path).not.toContain('://')
			if (route.requiresOrg) {
				expect(route.path).toContain(':orgSlug')
			} else {
				expect(route.path).not.toContain(':orgSlug')
			}
		}
	})

	it('resolves organization settings with the current org slug', () => {
		const result = resolveAppNavPath('org-settings', { orgSlug: 'acme' })
		expect(result).toEqual({
			ok: true,
			path: '/acme/settings',
			route: expect.objectContaining({ id: 'org-settings' }),
		})
	})

	it('resolves the organization media library', () => {
		const result = resolveAppNavPath('media', { orgSlug: 'acme' })
		expect(result).toEqual({
			ok: true,
			path: '/acme/media',
			route: expect.objectContaining({ id: 'media' }),
		})
	})

	it('resolves account routes without an org slug', () => {
		const result = resolveAppNavPath('account-profile', {})
		expect(result).toEqual({
			ok: true,
			path: '/profile',
			route: expect.objectContaining({ id: 'account-profile' }),
		})
	})

	it('rejects unknown ids and org routes without a slug', () => {
		expect(resolveAppNavPath('not-a-route', { orgSlug: 'acme' })).toEqual({
			ok: false,
			error: expect.stringContaining('Unknown route id'),
		})
		expect(resolveAppNavPath('org-settings', {})).toEqual({
			ok: false,
			error: expect.stringContaining('organization slug'),
		})
	})

	it('rejects unsafe organization slugs', () => {
		expect(
			resolveAppNavPath('org-settings', { orgSlug: '../admin' }),
		).toMatchObject({ ok: false })
		expect(
			resolveAppNavPath('dashboard', { orgSlug: 'https://evil.example' }),
		).toMatchObject({ ok: false })
	})

	it('can hide billing', () => {
		const withBilling = getNavigableAppRoutes()
		const withoutBilling = getNavigableAppRoutes({ includeBilling: false })
		expect(
			withBilling.some((route) => route.id === 'org-settings-billing'),
		).toBe(true)
		expect(
			withoutBilling.some((route) => route.id === 'org-settings-billing'),
		).toBe(false)
	})

	it('puts the current location and org slug into the system prompt', () => {
		const prompt = buildNavigationSystemPrompt('base', {
			location: {
				currentPath: '/acme/notes',
				orgSlug: 'acme',
				params: { orgSlug: 'acme' },
			},
			routes: getNavigableAppRoutes(),
		})

		expect(prompt).toContain('Current location: /acme/notes')
		expect(prompt).toContain('Current organization slug (orgSlug): acme')
		expect(prompt).toContain('org-settings — Organization settings')
		expect(prompt).toContain('navigateToAppPage')
	})
})
