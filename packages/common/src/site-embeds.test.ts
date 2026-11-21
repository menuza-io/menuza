import { describe, expect, it } from 'vitest'
import {
	buildEmbedFrame,
	EMBED_PROVIDERS,
	embedFrameOrigins,
	isBookingEmbed,
	MAX_EMBED_INPUT,
	normalizeEmbedHeight,
	parseEmbed,
	readEmbedConfig,
} from './site-embeds.ts'

const OT_SNIPPET =
	'<script type="text/javascript" src="//www.opentable.com/widget/reservation/loader?rid=12345&type=standard&theme=standard&color=1&dark=false&iframe=true&domain=com&lang=en-US&newtab=false&ot_source=Restaurant%20website&cfe=true"></script>'

describe('parseEmbed: accepted forms', () => {
	it('OpenTable: the loader script, a restref link and a widget address', () => {
		for (const input of [
			OT_SNIPPET,
			'https://www.opentable.com/restref/client/?rid=12345&restref=12345',
			'https://www.opentable.co.uk/widget/reservation/canvas?rid=12345&type=standard',
		]) {
			expect(parseEmbed('opentable', input)).toEqual({
				ok: true,
				provider: 'opentable',
				ids: { restaurantId: '12345' },
				detected: 'restaurant 12345',
			})
		}
	})

	it('Resy: the widget snippet, the widget address and a venue link', () => {
		const snippet =
			'<a href="https://resy.com/cities/ny/venues/the-diner" data-venue-id="4321" data-api-key="AbCdEf123456"></a><script src="https://widgets.resy.com/embed.js"></script>'
		expect(parseEmbed('resy', snippet)).toMatchObject({
			ok: true,
			ids: { city: 'ny', venue: 'the-diner' },
		})
		expect(
			parseEmbed(
				'resy',
				'<div data-venue-id="4321" data-api-key="AbCdEf123456"></div>',
			),
		).toMatchObject({
			ok: true,
			ids: { venueId: '4321', apiKey: 'AbCdEf123456' },
			detected: 'venue 4321',
		})
		expect(
			parseEmbed(
				'resy',
				'https://widgets.resy.com/#/reservations?venueId=4321&apiKey=AbCdEf123456',
			),
		).toMatchObject({ ok: true, ids: { venueId: '4321' } })
	})

	it('Untappd: the embed snippet and menu links', () => {
		expect(
			parseEmbed(
				'untappd',
				'<script src="https://embed.untappdmenus.com/embed.js"></script><div id="menu-container" data-embed-id="778899"></div>',
			),
		).toMatchObject({
			ok: true,
			ids: { menuId: '778899' },
			detected: 'menu 778899',
		})
		expect(
			parseEmbed(
				'untappd',
				'https://business.untappd.com/locations/4455/themes/9',
			),
		).toMatchObject({ ok: true, ids: { menuId: '4455' } })
		expect(
			parseEmbed('untappd', 'https://untappd.com/v/the-pub/123456'),
		).toMatchObject({ ok: true, ids: { menuId: '123456' } })
	})

	it('Google Maps: an embed iframe', () => {
		const pb = '!1m18!1m12!1m3!1d3022.1!2d-73.98!3d40.75!2m3!1f0!2f0!3f0'
		const iframe = `<iframe src="https://www.google.com/maps/embed?pb=${pb}" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy"></iframe>`
		const parsed = parseEmbed('google_maps', iframe)
		expect(parsed).toMatchObject({ ok: true, detected: 'map' })
		if (parsed.ok) expect(parsed.ids.pb).toBe(pb)
	})

	it('YouTube and Vimeo: videos and playlists', () => {
		expect(parseEmbed('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toMatchObject(
			{
				ok: true,
				ids: { video: 'dQw4w9WgXcQ' },
			},
		)
		expect(
			parseEmbed(
				'youtube',
				'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
			),
		).toMatchObject({
			ok: true,
			ids: { playlist: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' },
		})
		expect(
			parseEmbed(
				'youtube',
				'<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" allowfullscreen></iframe>',
			),
		).toMatchObject({ ok: true, ids: { video: 'dQw4w9WgXcQ' } })
		expect(parseEmbed('vimeo', 'https://vimeo.com/76979871')).toMatchObject({
			ok: true,
			ids: { video: '76979871' },
		})
		expect(
			parseEmbed(
				'vimeo',
				'<iframe src="https://player.vimeo.com/video/76979871"></iframe>',
			),
		).toMatchObject({ ok: true, ids: { video: '76979871' } })
		expect(
			parseEmbed('vimeo', 'https://vimeo.com/showcase/8888888'),
		).toMatchObject({ ok: true, ids: { showcase: '8888888' } })
	})

	it('Eventbrite and Instagram', () => {
		expect(
			parseEmbed(
				'eventbrite',
				'https://www.eventbrite.com/e/trivia-night-tickets-123456789012',
			),
		).toMatchObject({ ok: true, ids: { eventId: '123456789012' } })
		expect(
			parseEmbed(
				'eventbrite',
				'<iframe src="//www.eventbrite.com/tickets-external?eid=123456789012&ref=etckt"></iframe>',
			),
		).toMatchObject({ ok: true, ids: { eventId: '123456789012' } })
		expect(
			parseEmbed(
				'instagram',
				'https://www.instagram.com/p/CxYz123AbC/?utm_source=ig_web',
			),
		).toMatchObject({ ok: true, ids: { kind: 'p', code: 'CxYz123AbC' } })
		expect(
			parseEmbed('instagram', 'https://www.instagram.com/reel/CxYz123AbC/'),
		).toMatchObject({ ok: true, ids: { kind: 'reel' } })
	})
})

describe('parseEmbed: hostile and unknown input is refused', () => {
	const refused = { ok: false, error: 'embed_unsupported' }

	it('refuses arbitrary script and HTML', () => {
		for (const input of [
			'<script>alert(document.cookie)</script>',
			'<img src=x onerror=alert(1)>',
			'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'<style>body{display:none}</style>',
			'just some words',
			'',
		]) {
			expect(parseEmbed('opentable', input)).toEqual(refused)
			expect(parseEmbed('youtube', input)).toEqual(refused)
		}
	})

	it('refuses a look-alike or unrelated host, even with a valid id', () => {
		for (const input of [
			'<script src="https://evil.example/widget?rid=12345"></script>',
			'https://www.opentable.com.evil.example/widget?rid=12345',
			'https://evil-opentable.com/restref/client/?rid=12345',
			'https://notopentable.com/?rid=12345',
			'https://user:pass@www.opentable.com/?rid=12345',
		]) {
			expect(parseEmbed('opentable', input)).toEqual(refused)
		}
		expect(
			parseEmbed(
				'youtube',
				'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
			),
		).toEqual(refused)
		expect(parseEmbed('vimeo', 'https://fakevimeo.com/76979871')).toEqual(
			refused,
		)
	})

	it("refuses another provider's link and an unknown provider", () => {
		expect(parseEmbed('resy', 'https://youtu.be/dQw4w9WgXcQ')).toEqual(refused)
		expect(parseEmbed('youtube', OT_SNIPPET)).toEqual(refused)
		expect(parseEmbed('twitter', 'https://twitter.com/x/status/1')).toEqual(
			refused,
		)
		expect(parseEmbed(undefined, OT_SNIPPET)).toEqual(refused)
		expect(parseEmbed('opentable', 42)).toEqual(refused)
	})

	it('refuses ids with the wrong shape and over-long input', () => {
		expect(
			parseEmbed('opentable', 'https://www.opentable.com/?rid=12a45'),
		).toEqual(refused)
		expect(
			parseEmbed(
				'opentable',
				'https://www.opentable.com/?rid=1234567890123456',
			),
		).toEqual(refused)
		expect(
			parseEmbed('youtube', 'https://www.youtube.com/watch?v=short'),
		).toEqual(refused)
		expect(
			parseEmbed('opentable', `${OT_SNIPPET}${' '.repeat(MAX_EMBED_INPUT)}`),
		).toEqual(refused)
	})

	it('upgrades http addresses to https and never keeps any pasted markup', () => {
		const parsed = parseEmbed(
			'opentable',
			'<div onclick="steal()"><a href="http://www.opentable.com/restref/client/?rid=777">Book</a></div>',
		)
		expect(parsed).toEqual({
			ok: true,
			provider: 'opentable',
			ids: { restaurantId: '777' },
			detected: 'restaurant 777',
		})
		expect(JSON.stringify(parsed)).not.toContain('steal')
		expect(JSON.stringify(parsed)).not.toContain('<')
	})
})

describe('buildEmbedFrame: the frame is built, never copied', () => {
	it('builds an https frame on the provider origin for every provider', () => {
		const samples: Record<string, { ids: Record<string, string> }> = {
			opentable: { ids: { restaurantId: '12345' } },
			resy: { ids: { venueId: '4321', apiKey: 'AbCdEf123456' } },
			untappd: { ids: { menuId: '778899' } },
			google_maps: { ids: { pb: '!1m18!1m12!1m3!1d3022.1!2d-73.98!3d40.75' } },
			youtube: { ids: { video: 'dQw4w9WgXcQ' } },
			vimeo: { ids: { video: '76979871' } },
			eventbrite: { ids: { eventId: '123456789012' } },
			instagram: { ids: { kind: 'p', code: 'CxYz123AbC' } },
		}
		for (const provider of EMBED_PROVIDERS) {
			const frame = buildEmbedFrame({
				provider,
				...samples[provider]!,
				height: 'auto',
			})
			expect(frame, provider).not.toBeNull()
			expect(frame!.src.startsWith('https://')).toBe(true)
			expect(frame!.sandbox).toContain('allow-scripts')
			expect(frame!.sandbox).not.toContain('allow-top-navigation')
			expect(frame!.consent).toBe('marketing')
			expect(frame!.fallbackUrl.startsWith('https://')).toBe(true)
		}
	})

	it('gives a player a 16:9 shape and a booking widget a fixed height', () => {
		expect(
			buildEmbedFrame({
				provider: 'youtube',
				ids: { video: 'dQw4w9WgXcQ' },
				height: 'auto',
			})!.size,
		).toEqual({ kind: 'aspect', ratio: '16/9' })
		expect(
			buildEmbedFrame({
				provider: 'opentable',
				ids: { restaurantId: '1' },
				height: 'auto',
			})!.size,
		).toEqual({ kind: 'px', px: 320 })
		expect(normalizeEmbedHeight('opentable', 99999)).toBe(1600)
		expect(normalizeEmbedHeight('opentable', 10)).toBe(200)
		expect(normalizeEmbedHeight('youtube', 'auto')).toBe('auto')
	})

	it('refuses a hand-written config with an address, a script or an unknown key', () => {
		for (const config of [
			{
				provider: 'opentable',
				ids: { restaurantId: 'https://evil.example' },
				height: 300,
			},
			{ provider: 'opentable', ids: { restaurantId: '<script>' }, height: 300 },
			{
				provider: 'opentable',
				ids: { src: 'https://evil.example/x' },
				height: 300,
			},
			{ provider: 'evil', ids: { restaurantId: '1' } },
			{ provider: 'opentable', ids: {} },
			{ provider: 'youtube', ids: { video: '"><script>alert(1)</script>' } },
			null,
			'string',
		]) {
			expect(buildEmbedFrame(config)).toBeNull()
			expect(readEmbedConfig(config)).toBeNull()
		}
	})

	it('never carries pasted markup into the frame', () => {
		const frame = buildEmbedFrame({
			provider: 'opentable',
			ids: { restaurantId: '12345' },
			height: 320,
			html: '<script>alert(1)</script>',
			src: 'https://evil.example',
		})!
		expect(JSON.stringify(frame)).not.toContain('evil')
		expect(JSON.stringify(frame)).not.toContain('<script')
	})
})

describe('embedFrameOrigins: only the providers a page uses', () => {
	const section = (config: unknown) => ({
		type: 'embed',
		config: JSON.stringify(config),
	})
	it('adds nothing for a page with no embed', () => {
		expect(embedFrameOrigins([{ type: 'hero', config: '{}' }])).toEqual([])
	})
	it('adds exactly the origins of the providers in use', () => {
		expect(
			embedFrameOrigins([
				section({ provider: 'opentable', ids: { restaurantId: '1' } }),
				section({ provider: 'opentable', ids: { restaurantId: '2' } }),
			]),
		).toEqual(['https://www.opentable.com'])
		expect(
			embedFrameOrigins([
				section({ provider: 'youtube', ids: { video: 'dQw4w9WgXcQ' } }),
				section({ provider: 'untappd', ids: { menuId: '5' } }),
			]),
		).toEqual([
			'https://embed.untappdmenus.com',
			'https://www.youtube-nocookie.com',
		])
	})
	it('ignores an embed section whose config is not valid', () => {
		expect(
			embedFrameOrigins([
				section({ provider: 'opentable', ids: { restaurantId: 'x' } }),
				{ type: 'embed', config: 'not json' },
			]),
		).toEqual([])
	})
	it('flags booking providers', () => {
		expect(isBookingEmbed('opentable')).toBe(true)
		expect(isBookingEmbed('resy')).toBe(true)
		expect(isBookingEmbed('youtube')).toBe(false)
	})
})
