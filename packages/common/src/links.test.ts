import { describe, expect, it } from 'vitest'
import {
	androidIntentPaths,
	APP_LINK_VERSION,
	associationPaths,
	buildAppleAppSiteAssociation,
	buildAssetLinks,
	buildLink,
	buildLinkTemplate,
	buildLinkTemplatePath,
	buildOperatorLink,
	GUEST_LINK_TYPES,
	type GuestLinkType,
	LinkParamError,
	linkTypesFor,
	resolveLink,
	resolveOperatorLink,
} from './links.ts'

const ORIGIN = 'https://acme.menuza.io'
const HEX = 'a'.repeat(64)
const own = { appHost: 'acme.menuza.io', platform: 'ios' as const }

const SAMPLES: Array<{ type: GuestLinkType; params: Record<string, string> }> =
	[
		{ type: 'menu_home', params: {} },
		{ type: 'menu_home', params: { location: 'loc_1' } },
		{ type: 'dish', params: { item: 'item_9' } },
		{ type: 'coupon', params: { coupon: 'WELCOME10' } },
		{ type: 'order', params: { order: 'ord_1', link: HEX } },
		{ type: 'order', params: { order: 'ord_1' } },
		{ type: 'cart', params: { cart: '1700000000000.cust_1.' + HEX } },
		{ type: 'table', params: { location: 'loc_1', table: 'tabletoken123' } },
		{ type: 'order_ahead', params: { location: 'loc_1', src: 'qr' } },
		{ type: 'reserve', params: {} },
		{
			type: 'reservation',
			params: { reservation: 'r_1', token: 'tok-ABCDEFGH' },
		},
		{ type: 'reservation', params: { token: 'tok-ABCDEFGH' } },
		{ type: 'waitlist', params: { token: 'tok-ABCDEFGH' } },
		{
			type: 'reservation_pay',
			params: { reservation: 'r_1', token: 'tok-ABCDEFGH' },
		},
		{
			type: 'catering_quote',
			params: { quote: '0b2f4c5e-1a3d-4e6f-8a9b-1c2d3e4f5a6b.2.' + HEX },
		},
		{
			type: 'catering_balance',
			params: { balance: '0b2f4c5e-1a3d-4e6f-8a9b-1c2d3e4f5a6b.1.' + HEX },
		},
		{ type: 'loyalty', params: {} },
		{ type: 'gift_cards', params: {} },
	]

describe('buildLink / resolveLink round trips', () => {
	for (const sample of SAMPLES) {
		it(`${sample.type} ${JSON.stringify(sample.params)}`, () => {
			const url = buildLink(sample.type, sample.params, { origin: ORIGIN })!
			expect(url.startsWith(`${ORIGIN}/`)).toBe(true)
			const def = GUEST_LINK_TYPES[sample.type]
			const resolved = resolveLink(url, own)
			if (def.appRoute === null) {
				expect(resolved).toMatchObject({ kind: 'web', reason: 'not_in_app' })
				return
			}
			expect(resolved.kind).toBe('app')
			if (resolved.kind !== 'app') return
			expect(resolved.type).toBe(sample.type)
			// Everything we put in comes back: in the route, the query or the fragment.
			const back = { ...resolved.query, ...resolved.fragment }
			const flat = Object.entries(sample.params)
			for (const [name, value] of flat) {
				const present =
					Object.values(back).includes(value) ||
					resolved.route.includes(encodeURIComponent(value))
				expect(present).toBe(true)
				void name
			}
			expect(resolved.web).toBe(url)
		})
	}
})

describe('tokens stay in the fragment', () => {
	it('puts every capability token after #, never in the path or query', () => {
		for (const sample of SAMPLES) {
			const url = new URL(
				buildLink(sample.type, sample.params, { origin: ORIGIN })!,
			)
			const def = GUEST_LINK_TYPES[sample.type]
			for (const [name, spec] of Object.entries(def.params)) {
				const value = sample.params[name]
				if (!value) continue
				if (spec.in === 'fragment') {
					expect(url.hash).toContain(value)
					expect(url.pathname + url.search).not.toContain(value)
				}
			}
		}
	})

	it('hands fragment tokens to the screen without putting them in the route or query', () => {
		const resolved = resolveLink(
			buildLink('order', { order: 'ord_1', link: HEX }, { origin: ORIGIN })!,
			own,
		)
		expect(resolved).toMatchObject({
			kind: 'app',
			route: '/orders/ord_1',
			fragment: { link: HEX },
		})
		if (resolved.kind === 'app') {
			expect(JSON.stringify(resolved.query)).not.toContain(HEX)
			expect(resolved.route).not.toContain(HEX)
		}
	})

	it('has no fragment, token or query value in the association files', () => {
		const aasa = JSON.stringify(
			buildAppleAppSiteAssociation({
				appleTeamId: 'TEAM123456',
				iosBundleId: 'com.acme.app',
				androidPackage: 'com.acme.app',
				androidSha256: [],
			}),
		)
		expect(aasa).not.toMatch(/#|link=|token|\?/)
		for (const path of [...associationPaths(), ...androidIntentPaths()]) {
			expect(path.startsWith('/')).toBe(true)
			expect(path).not.toMatch(/[#?=]/)
		}
	})
})

describe('the same link on a phone without the app (#195 criterion 2)', () => {
	it('the built address is the website address itself', () => {
		const url = buildLink(
			'order',
			{ order: 'ord_1', link: HEX },
			{ origin: ORIGIN },
		)!
		expect(new URL(url).host).toBe('acme.menuza.io')
		expect(url).toBe(`${ORIGIN}/menu/success?order=ord_1#link=${HEX}`)
	})
})

describe('who owns a link', () => {
	const url = buildLink('order', { order: 'ord_1' }, { origin: ORIGIN })!

	it("a link to another organization's content opens the website", () => {
		const other = buildLink(
			'order',
			{ order: 'ord_1' },
			{ origin: 'https://other.menuza.io' },
		)!
		expect(resolveLink(other, own)).toMatchObject({
			kind: 'web',
			reason: 'other_host',
		})
	})

	it('the shared app claims no restaurant domain', () => {
		expect(resolveLink(url, { appHost: null, platform: 'ios' })).toMatchObject({
			kind: 'web',
			reason: 'other_host',
		})
		expect(
			resolveLink(url, { appHost: '', platform: 'android' }),
		).toMatchObject({ kind: 'web', reason: 'other_host' })
	})

	it('host matching is exact: a lookalike host is not the app’s', () => {
		const lookalike =
			'https://acme.menuza.io.evil.example/menu/success?order=o1'
		expect(resolveLink(lookalike, own)).toMatchObject({
			kind: 'web',
			reason: 'other_host',
		})
		expect(
			resolveLink('https://xacme.menuza.io/menu/success?order=o1', own),
		).toMatchObject({ reason: 'other_host' })
	})

	it('falls back to the website for a type the installed version does not know', () => {
		expect(resolveLink(url, { ...own, appLinkVersion: 0 })).toMatchObject({
			kind: 'web',
			reason: 'app_too_old',
		})
		expect(
			resolveLink(url, { ...own, appLinkVersion: APP_LINK_VERSION }),
		).toMatchObject({ kind: 'app' })
		expect(resolveLink(`${ORIGIN}/something/new`, own)).toMatchObject({
			kind: 'web',
			reason: 'unknown_type',
		})
		expect(resolveLink(`${ORIGIN}/menu/success`, own)).toMatchObject({
			kind: 'web',
			reason: 'unknown_type',
		})
	})

	it('a language prefix does not hide the type', () => {
		const arabic = buildLink(
			'order',
			{ order: 'ord_1' },
			{ origin: ORIGIN, localePrefix: '/ar' },
		)!
		expect(arabic).toBe(`${ORIGIN}/ar/menu/success?order=ord_1`)
		expect(resolveLink(arabic, own)).toMatchObject({
			kind: 'app',
			type: 'order',
			route: '/orders/ord_1',
		})
	})

	it('refuses other schemes and credentials', () => {
		expect(resolveLink('javascript:alert(1)', own)).toMatchObject({
			kind: 'web',
			reason: 'invalid',
		})
		expect(resolveLink('https://u:p@acme.menuza.io/menu', own)).toMatchObject({
			kind: 'web',
			reason: 'invalid',
		})
		expect(resolveLink('not a url', own)).toMatchObject({
			kind: 'web',
			reason: 'invalid',
		})
	})

	it('web-only types stay on the website (cart, table, payment)', () => {
		for (const type of [
			'cart',
			'table',
			'reservation_pay',
			'catering_quote',
			'catering_balance',
		] as const) {
			const sample = SAMPLES.find((s) => s.type === type)!
			const link = buildLink(type, sample.params, { origin: ORIGIN })!
			expect(resolveLink(link, own)).toMatchObject({
				kind: 'web',
				reason: 'not_in_app',
			})
		}
		expect(linkTypesFor('ios')).not.toContain('cart')
		expect(linkTypesFor('web')).toContain('cart')
	})
})

describe('building', () => {
	it('refuses parameters that are not the type’s or do not validate', () => {
		expect(() => buildLink('order', {}, { origin: ORIGIN })).toThrow(
			LinkParamError,
		)
		expect(() =>
			buildLink('order', { order: 'a b' }, { origin: ORIGIN }),
		).toThrow(LinkParamError)
		expect(() =>
			buildLink('order', { order: 'ord_1', link: 'short' }, { origin: ORIGIN }),
		).toThrow(LinkParamError)
		expect(() =>
			buildLink('menu_home', { nope: 'x' }, { origin: ORIGIN }),
		).toThrow(LinkParamError)
		expect(() =>
			buildLink('dish', { item: '../../etc' }, { origin: ORIGIN }),
		).toThrow(LinkParamError)
	})

	it('gives null without a usable site origin', () => {
		expect(buildLink('menu_home', {}, { origin: null })).toBeNull()
		expect(
			buildLink('menu_home', {}, { origin: 'ftp://acme.menuza.io' }),
		).toBeNull()
		expect(
			buildLink('menu_home', {}, { origin: 'https://user:pw@acme.menuza.io' }),
		).toBeNull()
	})

	it('ignores an unsafe language prefix', () => {
		expect(
			buildLink(
				'menu_home',
				{},
				{ origin: ORIGIN, localePrefix: '//evil.example' },
			),
		).toBe(`${ORIGIN}/menu`)
	})
})

describe('association files', () => {
	const binding = {
		appleTeamId: 'TEAM123456',
		iosBundleId: 'com.acme.app',
		androidPackage: 'com.acme.app',
		androidSha256: ['AA:'.repeat(31) + 'AA'],
	}

	it('names the app and its paths, and nothing for a site without signing data', () => {
		const aasa = buildAppleAppSiteAssociation(binding)!
		expect(aasa.applinks.details[0]!.appIDs).toEqual([
			'TEAM123456.com.acme.app',
		])
		expect(aasa.applinks.details[0]!.components).toEqual(
			expect.arrayContaining([
				{ '/': '/menu/success' },
				{ '/': '/*/reserve/manage' },
			]),
		)
		expect(
			buildAppleAppSiteAssociation({ ...binding, appleTeamId: null }),
		).toBeNull()
		expect(buildAssetLinks({ ...binding, androidSha256: [] })).toBeNull()
		expect(buildAssetLinks(binding)).toEqual([
			{
				relation: ['delegate_permission/common.handle_all_urls'],
				target: {
					namespace: 'android_app',
					package_name: 'com.acme.app',
					sha256_cert_fingerprints: binding.androidSha256,
				},
			},
		])
	})

	it('claims only app-capable paths', () => {
		expect(associationPaths()).not.toContain('/reserve/pay')
		expect(associationPaths()).toContain('/menu/success')
		expect(androidIntentPaths()).toEqual(
			expect.arrayContaining(['/menu', '/menu/success', '/reserve/manage']),
		)
		expect(androidIntentPaths()).not.toContain('/reserve/pay')
	})
})

describe('operator links', () => {
	const base = 'https://app.menuza.io'
	it('builds and resolves order, thread and form response links', () => {
		const order = buildOperatorLink(
			'operator_order',
			{ order: 'ord_9' },
			{ baseUrl: base, orgSlug: 'acme' },
		)!
		expect(order).toBe('https://app.menuza.io/acme/orders/ord_9')
		expect(
			resolveOperatorLink(order, { hosts: ['app.menuza.io'], platform: 'ios' }),
		).toMatchObject({
			type: 'operator_order',
			orgSlug: 'acme',
			route: '/orders/ord_9',
		})
		const thread = buildOperatorLink(
			'operator_mailbox_thread',
			{ thread: 't_1' },
			{ baseUrl: base, orgSlug: 'acme' },
		)!
		expect(thread).toBe('https://app.menuza.io/acme/mailbox?thread=t_1')
		expect(
			resolveOperatorLink(thread, {
				hosts: ['app.menuza.io'],
				platform: 'android',
			}),
		).toMatchObject({ type: 'operator_mailbox_thread', route: '/mailbox/t_1' })
		const form = buildOperatorLink(
			'operator_form_response',
			{ source: 'forms', form: 'f_1' },
			{ baseUrl: base, orgSlug: 'acme' },
		)!
		expect(form).toBe(
			'https://app.menuza.io/acme/mailbox?source=forms&form=f_1',
		)
		expect(
			resolveOperatorLink(form, { hosts: ['app.menuza.io'], platform: 'ios' }),
		).toMatchObject({
			type: 'operator_form_response',
			route: '/mailbox/forms/f_1',
		})
	})

	it('opens only hosts the app names', () => {
		expect(
			resolveOperatorLink('https://evil.example/acme/orders/o1', {
				hosts: ['app.menuza.io'],
				platform: 'ios',
			}),
		).toBeNull()
		expect(
			resolveOperatorLink('https://app.menuza.io/acme/settings', {
				hosts: ['app.menuza.io'],
				platform: 'ios',
			}),
		).toBeNull()
	})
})

describe('templates and site bases with a language', () => {
	it('takes a site base that already carries its language', () => {
		expect(
			buildLink(
				'waitlist',
				{ token: 'tok-ABCDEFGH' },
				{ origin: 'https://acme.menuza.io/ar' },
			),
		).toBe('https://acme.menuza.io/ar/reserve/waitlist#t=tok-ABCDEFGH')
	})

	it('lets a marketing template carry a merge tag only through buildLinkTemplate', () => {
		expect(buildLinkTemplatePath('coupon', { coupon: '{{couponCode}}' })).toBe(
			'/menu?coupon={{couponCode}}',
		)
		expect(() =>
			buildLink('coupon', { coupon: '{{couponCode}}' }, { origin: ORIGIN }),
		).toThrow(LinkParamError)
		expect(() =>
			buildLinkTemplate(
				'coupon',
				{ coupon: '{{a}}\u0001' },
				{ origin: ORIGIN },
			),
		).toThrow(LinkParamError)
	})

	it('carries the slot a notify-me message offers', () => {
		const url = buildLink(
			'reserve',
			{ location: 'loc1', party: '2', date: '2026-12-01', time: '19:30' },
			{ origin: ORIGIN },
		)!
		expect(new URL(url).searchParams.get('time')).toBe('19:30')
		expect(resolveLink(url, own)).toMatchObject({
			kind: 'app',
			type: 'reserve',
			route: '/reservations',
		})
	})
})

describe('links.ts loads in Node strip-only TypeScript mode', () => {
	it('uses no syntax that needs a transform (apps/customer/app.config.ts imports it)', async () => {
		const { readFileSync } = await import('node:fs')
		const source = readFileSync(new URL('./links.ts', import.meta.url), 'utf8')
		expect(source).not.toMatch(
			/constructor\s*\([^)]*\b(readonly|private|public|protected)\s/,
		)
		expect(source).not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s/m)
		expect(source).not.toMatch(/^\s*(export\s+)?namespace\s/m)
	})
})
