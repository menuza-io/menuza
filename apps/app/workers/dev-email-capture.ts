import {
	DEV_EMAIL_CAPTURE_CREATE_SQL,
	DEV_EMAIL_CAPTURE_TABLE,
	parseResendPayload,
	RESEND_EMAILS_URL,
} from '../app/utils/dev-email-capture.shared.ts'

/**
 * Workers dev has no MSW, so `sendEmail` would call the real Resend API. With
 * `MOCKS=true` the call is stored in the local control-plane D1 instead and
 * answered with a Resend-shaped success; `/mock-email` shows it. Other URLs are
 * untouched, and nothing is installed in a production build.
 */

let installed = false

export function installDevEmailCapture(env: Pick<Env, 'DB'>) {
	if (installed) return
	if (process.env.MOCKS !== 'true' || import.meta.env.PROD) return

	const database = env.DB
	const originalFetch = globalThis.fetch.bind(globalThis)
	let tableReady: Promise<unknown> | undefined

	globalThis.fetch = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init)
		if (request.method !== 'POST' || request.url !== RESEND_EMAILS_URL) {
			return originalFetch(input, init)
		}

		const payload = parseResendPayload(
			await request
				.clone()
				.json()
				.catch(() => null),
		)
		if (!payload) {
			return Response.json(
				{ name: 'validation_error', message: 'Invalid body', statusCode: 422 },
				{ status: 422 },
			)
		}

		tableReady ??= database.prepare(DEV_EMAIL_CAPTURE_CREATE_SQL).run()
		await tableReady
		const id = crypto.randomUUID()
		await database
			.prepare(
				`INSERT INTO ${DEV_EMAIL_CAPTURE_TABLE} (id, captured_at, to_addr, from_addr, subject, html, text, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				Date.now(),
				payload.to,
				payload.from,
				payload.subject,
				payload.html,
				payload.text,
				JSON.stringify(payload.meta),
			)
			.run()
		return Response.json({ id })
	}

	installed = true
}

/** Lets a test install the wrapper again against a fresh database. */
export function resetDevEmailCaptureForTests() {
	installed = false
}
