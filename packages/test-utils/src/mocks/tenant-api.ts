import { HttpResponse, http, type HttpHandler } from 'msw'

const { json } = HttpResponse

export const handlers: Array<HttpHandler> = [
	http.post('*/api/provision', async ({ request }) => {
		const body = (await request.json().catch(() => ({}))) as {
			dataRegion?: string
		}
		return json({
			ok: true,
			region: body.dataRegion || 'us',
		})
	}),
	http.post('*/api/deprovision', async ({ request }) => {
		const body = (await request.json().catch(() => ({}))) as {
			dataRegion?: string
		}
		return json({
			ok: true,
			region: body.dataRegion || 'us',
		})
	}),
	// Manual sold-out toggles mirror to the region (ids only); tests fire this async.
	http.post('*/api/menu/availability-events', () => json({ ok: true })),
]
