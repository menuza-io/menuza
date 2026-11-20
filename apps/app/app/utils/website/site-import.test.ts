import { describe, expect, it } from 'vitest'
import {
	backupHasForbiddenData,
	buildSiteBackup,
	capImportPages,
	checkImportTarget,
	crawlSite,
	extractReadablePage,
	pagesFromBackup,
	parseRobots,
	planImportRedirects,
	proposeSections,
	robotsAllows,
	IMPORT_PAGE_CAP,
	type SiteBackup,
} from './site-import.ts'
import { unzipStore, zipStore } from './zip-store.ts'

const HOST = 'old.example'

function page(path: string, body: string) {
	return {
		url: `https://${HOST}${path}`,
		html: `<!doctype html><html><head><title>${path}</title></head><body>${body}</body></html>`,
	}
}

const photo = (name: string) =>
	`<img src="https://${HOST}/photos/${name}.jpg" alt="${name} dish">`

const restaurant = [
	page(
		'/',
		`<h1>Al Bait</h1><p>A neighbourhood kitchen in Riyadh.</p>${photo('room')}`,
	),
	page(
		'/menu.html',
		`<h1>Menu</h1><p>Lentil soup and mixed grill.</p>${photo('soup')}${photo('grill')}`,
	),
	page(
		'/about-us',
		`<h1>About</h1><p>We cook Lebanese food every day.</p>${photo('kitchen')}`,
	),
	page(
		'/contact-us.php',
		`<h1>Contact</h1><p>Olaya Street. Call us.</p>${photo('door')}`,
	),
	page('/hours', `<h1>Hours</h1><p>Open 11:00 to 22:00.</p>`),
	page(
		'/private-dining',
		`<h1>Private dining</h1><p>A room for twelve.</p>${photo('room2')}`,
	),
	page(
		'/catering',
		`<h1>Catering</h1><p>Trays for the office.</p>${photo('tray')}`,
	),
	page(
		'/gallery.html',
		`<h1>Gallery</h1><p>A few photos.</p>${photo('a')}${photo('b')}`,
	),
	page(
		'/faq',
		`<h1>Questions</h1><h2>Do you have parking?</h2><p>Street parking on Olaya.</p>`,
	),
	page('/visit', `<h1>Visit</h1><p>Find us in Olaya.</p>`),
]

describe('website import (#140)', () => {
	it('proposes sections with text and images for a 10-page site', () => {
		const pages = restaurant.map((entry) =>
			extractReadablePage(entry.url, entry.html),
		)
		expect(pages).toHaveLength(10)
		const proposed = pages.map((entry) => proposeSections(entry))
		expect(proposed.every((sections) => sections.length > 0)).toBe(true)
		expect(proposed.flat().some((section) => section.type === 'hero')).toBe(
			true,
		)
		expect(proposed.flat().some((section) => section.type === 'content')).toBe(
			true,
		)
		expect(proposed.flat().some((section) => section.type === 'gallery')).toBe(
			true,
		)
		const menu = proposed[1]!
		expect(JSON.stringify(menu)).toContain('Lentil soup')
		expect(JSON.stringify(menu)).toContain('soup.jpg')
	})

	it('suggests a redirect for every old URL and refuses a loop', () => {
		const pages = restaurant.map((entry) => ({
			url: entry.url,
			slug:
				new URL(entry.url).pathname
					.replace(/\.(html|php)$/, '')
					.replace(/^\//, '') || 'home',
			skipped: false,
		}))
		const suggestions = planImportRedirects({ pages, existing: [] })
		expect(suggestions).toHaveLength(10)
		expect(suggestions.every((row) => row.statusCode === 301)).toBe(true)
		expect(suggestions.some((row) => row.ok && row.toPath === '/menu')).toBe(
			true,
		)
		const again = planImportRedirects({
			pages: [
				{ url: `https://${HOST}/loop`, slug: 'elsewhere', skipped: false },
			],
			existing: [{ id: 'back', fromPath: '/loop', toPath: '/elsewhere' }],
		})
		expect(again[0]?.reason).toBe('redirect_exists')
		const cyclic = planImportRedirects({
			pages: [
				{ url: `https://${HOST}/old-menu`, slug: 'menu', skipped: false },
			],
			existing: [{ id: 'cycle', fromPath: '/menu', toPath: '/old-menu' }],
		})
		expect(cyclic[0]?.ok).toBe(false)
		expect(cyclic[0]?.reason).toBe('redirect_loop')
		expect(
			suggestions
				.filter((row) => row.ok)
				.every((row) => row.fromPath !== row.toPath),
		).toBe(true)
	})

	it('refuses private and internal addresses', async () => {
		const resolve = async (host: string) =>
			host === 'old.example' ? ['93.184.216.34'] : ['127.0.0.1']
		expect(
			(
				await checkImportTarget('https://old.example/menu', {
					startHost: 'old.example',
					resolve,
				})
			).ok,
		).toBe(true)
		expect(
			(
				await checkImportTarget('http://127.0.0.1/admin', {
					startHost: '127.0.0.1',
					resolve,
				})
			).ok,
		).toBe(false)
		const privateDns = await checkImportTarget('https://old.example/secret', {
			startHost: 'old.example',
			resolve: async () => ['10.0.0.8'],
		})
		expect(privateDns.ok).toBe(false)
		if (!privateDns.ok) expect(privateDns.reason).toBe('blocked')
		const offSite = await checkImportTarget('https://evil.example/', {
			startHost: 'old.example',
			resolve,
		})
		expect(offSite.ok).toBe(false)
		if (!offSite.ok) expect(offSite.reason).toBe('off_site')
		const metadata = await checkImportTarget('http://169.254.169.254/latest', {
			startHost: '169.254.169.254',
			resolve: async () => ['169.254.169.254'],
		})
		expect(metadata.ok).toBe(false)
		if (!metadata.ok) expect(metadata.reason).toBe('blocked')
		const tooMany = await checkImportTarget('https://old.example/a', {
			startHost: 'old.example',
			resolve,
			redirectsFollowed: 6,
		})
		expect(tooMany.ok).toBe(false)
		if (!tooMany.ok) expect(tooMany.reason).toBe('blocked')
	})

	it('skips login walls, foreign forms and ordering widgets', () => {
		expect(
			extractReadablePage(
				`https://${HOST}/account`,
				'<form><input type="password" name="password"></form>',
			).skipReason,
		).toBe('login')
		expect(
			extractReadablePage(
				`https://${HOST}/order`,
				'<iframe src="https://www.doordash.com/store/1"></iframe>',
			).skipReason,
		).toBe('ordering_widget')
		expect(
			extractReadablePage(
				`https://${HOST}/jobs`,
				'<form action="https://jobs.other.test/apply"></form>',
			).skipReason,
		).toBe('foreign_form')
		expect(
			proposeSections(
				extractReadablePage(
					`https://${HOST}/account`,
					'<form><input type="password"></form>',
				),
			),
		).toEqual([])
	})

	it('crawls a linked 10-page fixture without leaving the site', async () => {
		const pages = new Map(restaurant.map((entry) => [entry.url, entry.html]))
		const home = pages.get(`https://${HOST}/`)!
		const linked = restaurant
			.slice(1)
			.map((entry) => `<a href="${entry.url}">${entry.url}</a>`)
			.join('')
		pages.set(`https://${HOST}/`, home.replace('</body>', `${linked}</body>`))
		const fetched: string[] = []
		const found = await crawlSite({
			startUrl: `https://${HOST}/`,
			fetchPage: async (url) => {
				fetched.push(url)
				if (url.includes('evil.example')) throw new Error('left the site')
				return pages.get(url) ?? null
			},
		})
		expect(found).toHaveLength(10)
		expect(fetched.every((url) => url.includes(HOST))).toBe(true)
		expect(
			found
				.flatMap((page) => proposeSections(page))
				.some((section) => section.type === 'hero'),
		).toBe(true)
	})

	it('respects robots and the page cap', () => {
		const robots = parseRobots(
			'User-agent: *\nDisallow: /private\nAllow: /private/menu\n',
		)
		expect(robotsAllows('/private', robots)).toBe(false)
		expect(robotsAllows('/private/menu', robots)).toBe(true)
		expect(robotsAllows('/menu', robots)).toBe(true)
		expect(
			capImportPages(Array.from({ length: 80 }, (_, i) => i)),
		).toHaveLength(IMPORT_PAGE_CAP)
	})
})

describe('website export and restore (#140)', () => {
	const backup = buildSiteBackup({
		pages: [
			{
				title: 'About',
				slug: 'about',
				isHomePage: false,
				sections: [
					{
						type: 'content',
						config: { title: 'About', body: 'Hello' },
					},
					{ type: 'not-real', config: { title: 'nope' } },
				],
			},
		],
		theme: { theme: 'neutral' },
		header: { showCta: false },
		footer: { copyright: 'Al Bait' },
		redirects: [{ fromPath: '/old', toPath: '/about', statusCode: 301 }],
		forms: [{ id: 'form-1', name: 'Contact', fields: [{ type: 'email' }] }],
		media: [{ path: 'media/room.jpg', contentType: 'image/jpeg' }],
	})

	it('exports pages, theme, chrome, redirects and media without submissions', () => {
		expect(backup.pages).toHaveLength(1)
		expect(backup.theme).toEqual({ theme: 'neutral' })
		expect(backup.header).toEqual({ showCta: false })
		expect(backup.redirects[0]?.statusCode).toBe(301)
		expect(backup.media[0]?.path).toBe('media/room.jpg')
		expect(backup.forms[0]?.name).toBe('Contact')
		expect(backupHasForbiddenData(backup)).toBe(false)
		expect(JSON.stringify(backup)).not.toContain('submission')
		const source = {
			...backup,
			submissions: [{ email: 'guest@example.com' }],
		}
		const clean = buildSiteBackup(source)
		expect(clean).not.toHaveProperty('submissions')
		expect(JSON.stringify(clean)).not.toContain('guest@example.com')
	})

	it('restores an export as drafts and drops an unknown section', () => {
		const restored = pagesFromBackup(backup)
		expect(restored[0]).toMatchObject({
			title: 'About',
			slug: 'about',
			status: 'draft',
		})
		expect(restored[0]?.sections.map((section) => section.type)).toEqual([
			'content',
		])
	})

	it('round-trips the backup through a zip', () => {
		const encoded = new TextEncoder().encode(JSON.stringify(backup))
		const zip = zipStore([
			{ name: 'site.json', data: encoded },
			{ name: 'media/room.jpg', data: new Uint8Array([1, 2, 3]) },
		])
		const files = unzipStore(zip)
		const parsed = JSON.parse(
			new TextDecoder().decode(files.get('site.json')!),
		) as SiteBackup
		expect(pagesFromBackup(parsed)[0]?.slug).toBe('about')
		expect(files.get('media/room.jpg')).toEqual(new Uint8Array([1, 2, 3]))
	})
})
