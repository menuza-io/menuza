import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
	GENERATE_OBJECT_FILE_MEDIA_TYPES,
	generateObject,
	setGenerateObjectImplementation,
	setGenerateTextImplementation,
} from './generate.ts'

const sampleSchema = z.object({
	title: z.string(),
	count: z.number().int(),
})

describe('generateObject', () => {
	const originalMocks = process.env.MOCKS
	const originalNodeEnv = process.env.NODE_ENV
	const originalBaseUrl = process.env.BASE_URL

	afterEach(() => {
		setGenerateObjectImplementation(null)
		setGenerateTextImplementation(null)
		if (originalMocks === undefined) {
			delete process.env.MOCKS
		} else {
			process.env.MOCKS = originalMocks
		}
		if (originalNodeEnv === undefined) {
			delete process.env.NODE_ENV
		} else {
			process.env.NODE_ENV = originalNodeEnv
		}
		if (originalBaseUrl === undefined) {
			delete process.env.BASE_URL
		} else {
			process.env.BASE_URL = originalBaseUrl
		}
	})

	it('supports per-call injectable generator without live calls', async () => {
		const generator = vi.fn(async () => ({ title: 'Injected', count: 3 }))
		const result = await generateObject({
			schema: sampleSchema,
			prompt: 'Extract menu',
			generator,
		})
		expect(result).toEqual({ title: 'Injected', count: 3 })
		expect(generator).toHaveBeenCalledTimes(1)
	})

	it('supports module-level test hook via setGenerateObjectImplementation', async () => {
		setGenerateObjectImplementation(async () => ({ title: 'Hook', count: 7 }))
		const result = await generateObject({
			schema: sampleSchema,
			prompt: 'Extract menu',
		})
		expect(result).toEqual({ title: 'Hook', count: 7 })
	})

	it('returns mockOutput fixture when MOCKS=true without live calls', async () => {
		process.env.MOCKS = 'true'
		const spy = vi.fn()
		setGenerateTextImplementation(spy as never)

		const result = await generateObject({
			schema: sampleSchema,
			prompt: 'Extract menu',
			mockOutput: { title: 'Mock Menu', count: 2 },
		})

		expect(result).toEqual({ title: 'Mock Menu', count: 2 })
		expect(spy).not.toHaveBeenCalled()
	})

	it('passes multimodal file parts (pdf, jpeg, png, webp) to generateText messages', async () => {
		delete process.env.MOCKS
		const calls: unknown[] = []
		setGenerateTextImplementation((async (arg: unknown) => {
			calls.push(arg)
			return { output: { title: 'Parsed', count: 4 } }
		}) as never)

		const files = GENERATE_OBJECT_FILE_MEDIA_TYPES.map((mediaType, idx) => ({
			data: new Uint8Array([idx + 1, idx + 2]),
			mediaType,
			filename: `file-${idx}`,
		}))

		const result = await generateObject({
			schema: sampleSchema,
			system: 'You parse menus.',
			prompt: 'Parse these menu files',
			files,
		})

		expect(result).toEqual({ title: 'Parsed', count: 4 })
		expect(calls).toHaveLength(1)
		const call = calls[0] as {
			system?: string
			messages?: Array<{
				role: string
				content: Array<{
					type: string
					text?: string
					mediaType?: string
					filename?: string
				}>
			}>
		}
		expect(call.system).toBe('You parse menus.')
		expect(call.messages).toHaveLength(1)
		expect(call.messages![0]!.role).toBe('user')
		expect(call.messages![0]!.content).toEqual([
			{ type: 'text', text: 'Parse these menu files' },
			{
				type: 'file',
				data: new Uint8Array([1, 2]),
				mediaType: 'application/pdf',
				filename: 'file-0',
			},
			{
				type: 'file',
				data: new Uint8Array([2, 3]),
				mediaType: 'image/jpeg',
				filename: 'file-1',
			},
			{
				type: 'file',
				data: new Uint8Array([3, 4]),
				mediaType: 'image/png',
				filename: 'file-2',
			},
			{
				type: 'file',
				data: new Uint8Array([4, 5]),
				mediaType: 'image/webp',
				filename: 'file-3',
			},
		])
	})

	it('gates MOCKS=true on non-production or local BASE_URL', async () => {
		process.env.MOCKS = 'true'
		process.env.NODE_ENV = 'production'
		process.env.BASE_URL = 'https://app.example.com'
		const spy = vi.fn(async () => ({ output: { title: 'Live', count: 1 } }))
		setGenerateTextImplementation(spy as never)

		const prodResult = await generateObject({
			schema: sampleSchema,
			prompt: 'Extract menu',
			mockOutput: { title: 'Mock Menu', count: 2 },
		})
		expect(prodResult).toEqual({ title: 'Live', count: 1 })
		expect(spy).toHaveBeenCalledTimes(1)

		spy.mockClear()
		delete process.env.BASE_URL
		vi.stubEnv('VITEST', '')
		const prodNoBaseResult = await generateObject({
			schema: sampleSchema,
			prompt: 'Extract menu',
			mockOutput: { title: 'Mock Menu', count: 2 },
		})
		expect(prodNoBaseResult).toEqual({ title: 'Live', count: 1 })
		expect(spy).toHaveBeenCalledTimes(1)
		vi.unstubAllEnvs()

		spy.mockClear()
		process.env.MOCKS = 'true'
		process.env.NODE_ENV = 'production'
		process.env.BASE_URL = 'http://localhost:3001'
		const localProdResult = await generateObject({
			schema: sampleSchema,
			prompt: 'Extract menu',
			mockOutput: { title: 'Mock Menu', count: 2 },
		})
		expect(localProdResult).toEqual({ title: 'Mock Menu', count: 2 })
		expect(spy).not.toHaveBeenCalled()
	})

	it('forwards abortSignal to generateText', async () => {
		delete process.env.MOCKS
		const controller = new AbortController()
		const spy = vi.fn(async () => ({ output: { title: 'Ok', count: 1 } }))
		setGenerateTextImplementation(spy as never)

		await generateObject({
			schema: sampleSchema,
			prompt: 'Extract menu',
			abortSignal: controller.signal,
		})

		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				abortSignal: controller.signal,
			}),
		)
	})

	it('rejects unsupported file media types and URL file data before calling generator', async () => {
		const spy = vi.fn()
		await expect(
			generateObject({
				schema: sampleSchema,
				prompt: 'Parse',
				files: [
					{
						data: new Uint8Array([1]),
						mediaType: 'image/gif' as never,
					},
				],
				generator: spy,
			}),
		).rejects.toThrow(/Unsupported generateObject file mediaType/)
		await expect(
			generateObject({
				schema: sampleSchema,
				prompt: 'Parse',
				files: [
					{
						data: new URL('https://169.254.169.254/latest') as never,
						mediaType: 'application/pdf',
					},
				],
				generator: spy,
			}),
		).rejects.toThrow(/URL is not allowed/)
		expect(spy).not.toHaveBeenCalled()
	})
})
