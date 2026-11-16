import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { giftCardRoutes } from './gift-cards.ts'

/**
 * The public gift card routes refuse a bad request before they look at who is
 * asking: an oversize body (counted on the stream, not only the header) and an
 * out-of-bounds organization hint on a read. Neither test needs an
 * organization, because both are answered first.
 */

const app = new Hono()
app.route('/gift-cards', giftCardRoutes)

const POSTS = [
	'/gift-cards/purchase',
	'/gift-cards/balance',
	'/gift-cards/claim',
	'/gift-cards/gc_1/show-token',
]

/** A chunked body: a stream carries no content-length header. */
function chunked(bytes: number, chunk = 4_000) {
	let sent = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= bytes) {
				controller.close()
				return
			}
			const size = Math.min(chunk, bytes - sent)
			controller.enqueue(new TextEncoder().encode('a'.repeat(size)))
			sent += size
		},
	})
}

describe('body cap', () => {
	for (const path of POSTS) {
		it(`${path}: a chunked body over the cap is 413`, async () => {
			const res = await app.request(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: chunked(60_000),
				// @ts-expect-error Node's fetch needs this for a stream body.
				duplex: 'half',
			})
			expect(res.status).toBe(413)
			expect(res.headers.get('Cache-Control')).toContain('no-store')
		})

		it(`${path}: a declared length over the cap is 413`, async () => {
			const res = await app.request(path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': '60000',
				},
				body: JSON.stringify({}),
			})
			expect(res.status).toBe(413)
		})

		it(`${path}: a small invalid body is still a 400`, async () => {
			const res = await app.request(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{ not json',
			})
			expect(res.status).toBe(400)
		})
	}
})

describe('organization hints on a read', () => {
	for (const path of ['/gift-cards/options', '/gift-cards/mine']) {
		it(`${path}: a slug over 100 characters is 400`, async () => {
			const res = await app.request(`${path}?slug=${'s'.repeat(101)}`)
			expect(res.status).toBe(400)
		})
		it(`${path}: a host over 255 characters is 400`, async () => {
			const res = await app.request(`${path}?host=${'h'.repeat(256)}`)
			expect(res.status).toBe(400)
		})
		it(`${path}: an empty slug is 400`, async () => {
			const res = await app.request(`${path}?slug=`)
			expect(res.status).toBe(400)
		})
	}
})
