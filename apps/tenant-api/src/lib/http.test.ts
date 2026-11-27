import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readCappedRequestBytes, validationBody } from './http.ts'

describe('validationBody', () => {
	it('keeps the message of an ordinary issue', () => {
		const parsed = z
			.object({ name: z.string().min(3) })
			.safeParse({ name: 'x' })
		expect(parsed.success).toBe(false)
		if (parsed.success) return
		const [issue] = validationBody(parsed.error).issues
		expect(issue).toMatchObject({ path: 'name', code: 'too_small' })
		expect(issue).toHaveProperty('message')
	})

	it('drops the message of issues that would echo the rejected value', () => {
		const parsed = z
			.object({ kind: z.enum(['a', 'b']), tag: z.literal('x') })
			.safeParse({ kind: 'secret-kind', tag: 'secret-tag' })
		expect(parsed.success).toBe(false)
		if (parsed.success) return
		const body = validationBody(parsed.error)
		expect(body.issues).toHaveLength(2)
		for (const issue of body.issues) expect(issue).not.toHaveProperty('message')
		expect(JSON.stringify(body)).not.toContain('secret')
	})

	it('drops the message of unrecognized keys, which names the keys the caller chose', () => {
		const parsed = z
			.strictObject({ ok: z.string() })
			.safeParse({ ok: 'fine', 'a@example.com': 1, '+15550100': 2 })
		expect(parsed.success).toBe(false)
		if (parsed.success) return
		// Zod's own message lists the keys; the response must not.
		expect(parsed.error.issues[0]!.message).toContain('a@example.com')
		const body = validationBody(parsed.error)
		expect(body.issues).toEqual([{ path: '', code: 'unrecognized_keys' }])
		expect(JSON.stringify(body)).not.toContain('a@example.com')
		expect(JSON.stringify(body)).not.toContain('+15550100')
	})
})

describe('readCappedRequestBytes', () => {
	const post = (body: BodyInit, headers: Record<string, string> = {}) =>
		new Request('https://node.test/x', { method: 'POST', body, headers })

	it('reads a body under the cap whole', async () => {
		const bytes = await readCappedRequestBytes(
			post(new Uint8Array([1, 2, 3])),
			10,
		)
		expect([...bytes!]).toEqual([1, 2, 3])
	})

	it('refuses a declared length over the cap before reading', async () => {
		expect(
			await readCappedRequestBytes(
				post('abc', { 'content-length': '999' }),
				10,
			),
		).toBeNull()
	})

	it('cuts a body off at the cap even with no content-length, so a header cannot be trusted', async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(6))
			},
		})
		const request = new Request('https://node.test/x', {
			method: 'POST',
			body: stream,
			// @ts-expect-error duplex is required for a streaming body
			duplex: 'half',
		})
		expect(await readCappedRequestBytes(request, 10)).toBeNull()
	})
})
