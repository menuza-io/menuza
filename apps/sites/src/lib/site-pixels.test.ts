import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootSitePixels } from './site-pixels.ts'

describe('bootSitePixels', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('queues a TikTok page view for the vendor script to replay', () => {
		const inserted: { src?: string }[] = []
		const win = {
			document: {
				createElement: () => ({ async: false, src: '' }),
				getElementsByTagName: () => [
					{
						parentNode: {
							insertBefore(element: { src?: string }) {
								inserted.push(element)
							},
						},
					},
				],
				head: { appendChild() {} },
			},
		} as unknown as Window & { ttq?: unknown[] }
		vi.stubGlobal('window', win)
		const root = {
			dataset: { tiktokPixel: 'C1234567890' },
		} as unknown as HTMLElement

		bootSitePixels(root)

		expect(Array.isArray(win.ttq)).toBe(true)
		expect(win.ttq).toContainEqual(['page'])
		expect(inserted[0]?.src).toContain('analytics.tiktok.com')
	})

	it('queues a Facebook page view', () => {
		const win = {
			document: {
				createElement: () => ({ async: false, src: '' }),
				head: { appendChild() {} },
			},
		} as unknown as Window & { fbq?: { queue: unknown[][] } }
		vi.stubGlobal('window', win)
		const root = {
			dataset: { facebookPixel: '123456789' },
		} as unknown as HTMLElement

		bootSitePixels(root)

		expect(win.fbq?.queue).toContainEqual(['track', 'PageView'])
	})

	it('appends the Tag Manager script', () => {
		const appended: { src?: string }[] = []
		const win = {
			document: {
				createElement: () => ({ async: false, src: '' }),
				head: {
					appendChild(element: { src?: string }) {
						appended.push(element)
					},
				},
			},
		} as unknown as Window
		vi.stubGlobal('window', win)
		const root = {
			dataset: { googleTagManager: 'GTM-ABC123' },
		} as unknown as HTMLElement

		bootSitePixels(root)

		expect(appended[0]?.src).toContain('googletagmanager.com/gtm.js')
	})
})
