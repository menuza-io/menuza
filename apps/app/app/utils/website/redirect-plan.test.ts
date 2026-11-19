import { describe, expect, it } from 'vitest'
import {
	hasRedirectCycle,
	normalizeRedirectPath,
	planAutomaticRedirect,
	websitePagePath,
} from './redirect-plan.ts'

describe('planAutomaticRedirect', () => {
	it('adds a 301 from the old path to the new one', () => {
		expect(
			planAutomaticRedirect({
				existing: [],
				oldPath: '/about-us',
				newPath: '/our-story',
				source: 'page_rename',
			}),
		).toEqual({
			deleteIds: [],
			updates: [],
			insert: {
				fromPath: '/about-us',
				toPath: '/our-story',
				source: 'page_rename',
			},
		})
	})

	it('renaming back removes the redirect that would hide the page and adds the reverse', () => {
		const plan = planAutomaticRedirect({
			existing: [
				{
					id: 'r1',
					fromPath: '/about-us',
					toPath: '/our-story',
					source: 'page_rename',
				},
			],
			oldPath: '/our-story',
			newPath: '/about-us',
			source: 'page_rename',
		})
		expect(plan.deleteIds).toEqual(['r1'])
		expect(plan.updates).toEqual([])
		expect(plan.insert).toEqual({
			fromPath: '/our-story',
			toPath: '/about-us',
			source: 'page_rename',
		})
	})

	it('collapses a chain to one hop', () => {
		const plan = planAutomaticRedirect({
			existing: [
				{ id: 'a', fromPath: '/a', toPath: '/b', source: 'page_rename' },
				{ id: 'm', fromPath: '/old-menu', toPath: '/b/', source: 'manual' },
				{
					id: 'x',
					fromPath: '/x',
					toPath: 'https://example.com/b',
					source: 'manual',
				},
			],
			oldPath: '/b',
			newPath: '/c',
			source: 'page_rename',
		})
		expect(plan.updates).toEqual([
			{ id: 'a', toPath: '/c' },
			{ id: 'm', toPath: '/c' },
		])
		expect(plan.insert).toMatchObject({ fromPath: '/b', toPath: '/c' })
	})

	it('keeps a manual redirect from the old path and adds nothing', () => {
		const plan = planAutomaticRedirect({
			existing: [
				{
					id: 'm',
					fromPath: '/About-Us',
					toPath: '/contact',
					source: 'manual',
				},
			],
			oldPath: '/about-us',
			newPath: '/our-story',
			source: 'page_rename',
		})
		expect(plan.insert).toBeNull()
		expect(plan.skipped).toBe('manual_redirect_exists')
	})

	it('never redirects the home page or a path to itself', () => {
		expect(
			planAutomaticRedirect({
				existing: [],
				oldPath: '/',
				newPath: '/home-2',
				source: 'page_rename',
			}).insert,
		).toBeNull()
		expect(
			planAutomaticRedirect({
				existing: [],
				oldPath: '/a',
				newPath: '/A',
				source: 'page_rename',
			}).skipped,
		).toBe('same_path')
	})

	it('refuses to create a loop on delete', () => {
		const plan = planAutomaticRedirect({
			existing: [{ id: 'r', fromPath: '/menu-2', toPath: '/gone' }],
			oldPath: '/gone',
			newPath: '/menu-2',
			source: 'page_delete',
		})
		expect(plan.skipped).toBe('redirect_loop')
		expect(plan.insert).toBeNull()
	})

	it('on delete points the deleted page and its chain at the destination', () => {
		const plan = planAutomaticRedirect({
			existing: [{ id: 'r', fromPath: '/older', toPath: '/gone' }],
			oldPath: '/gone',
			newPath: '/',
			source: 'page_delete',
		})
		expect(plan.updates).toEqual([{ id: 'r', toPath: '/' }])
		expect(plan.insert).toEqual({
			fromPath: '/gone',
			toPath: '/',
			source: 'page_delete',
		})
	})
})

describe('redirect helpers', () => {
	it('detects loops and self redirects', () => {
		const rows = [{ id: '1', fromPath: '/a', toPath: '/b' }]
		expect(hasRedirectCycle(rows, '/b', '/a')).toBe(true)
		expect(hasRedirectCycle(rows, '/c', '/c')).toBe(true)
		expect(hasRedirectCycle(rows, '/b', '/c')).toBe(false)
		expect(hasRedirectCycle(rows, '/b', 'https://x.test/a')).toBe(false)
	})

	it('normalizes paths and page paths', () => {
		expect(normalizeRedirectPath('about/')).toBe('/about')
		expect(normalizeRedirectPath('https://a.test/')).toBe('https://a.test/')
		expect(websitePagePath({ slug: 'home', isHomePage: true })).toBe('/')
		expect(websitePagePath({ slug: 'our-story' })).toBe('/our-story')
	})
})
