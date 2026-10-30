import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { validationBody } from './http.ts'

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
