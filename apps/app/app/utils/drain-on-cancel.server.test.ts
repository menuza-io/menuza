import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { drainOnCancel } from './drain-on-cancel.server.ts'

/** `Readable.toWeb()` is typed with the DOM `ReadableStream` in some lib setups. */
function toWeb(readable: Readable) {
	return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>
}

/**
 * Canceling a stream created with `Readable.toWeb()` while a resume tick is
 * already scheduled used to throw an uncatchable `ERR_INVALID_STATE: Controller
 * is already closed` from inside Node's stream adapter, killing the process.
 * `drainOnCancel` wraps such a stream so the source is drained instead of
 * canceled. See https://github.com/nodejs/node/issues/64529.
 */
describe('drainOnCancel', () => {
	it('forwards data from the source', async () => {
		const source = new PassThrough()
		const stream = drainOnCancel(toWeb(source))

		source.write(Buffer.from('hello'))
		source.write(Buffer.from(' world'))
		source.end()

		const reader = stream.getReader()
		const chunks: Uint8Array[] = []
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			chunks.push(value)
		}

		expect(Buffer.concat(chunks).toString()).toBe('hello world')
	})

	it('drains instead of canceling the source, so a client abort cannot crash the process', async () => {
		const uncaught: Array<unknown> = []
		const onUncaught = (error: unknown) => uncaught.push(error)
		process.on('uncaughtException', onUncaught)

		try {
			// A slow sink with a small high water mark forces the pause →
			// `pull()` → `resume()` cycles that make the race reproducible.
			for (let iteration = 0; iteration < 100; iteration++) {
				let pushed = 0
				const source = new Readable({
					read() {
						pushed += 16_384
						this.push(Buffer.alloc(16 * 1024, 1))
						if (pushed > 256 * 1024) this.push(null)
					},
				})
				const passThrough = new PassThrough({ highWaterMark: 16_384 })
				source.pipe(passThrough)

				const stream = drainOnCancel(toWeb(passThrough))
				const controller = new AbortController()
				const sink = new WritableStream(
					{
						async write() {
							await new Promise((resolve) => setTimeout(resolve, 1))
						},
					},
					{ highWaterMark: 1 },
				)
				setTimeout(() => controller.abort(), Math.floor(Math.random() * 12))

				try {
					await stream.pipeTo(sink, { signal: controller.signal })
				} catch {
					// The abort rejects `pipeTo`; that is expected.
				}
				await new Promise((resolve) => setImmediate(resolve))
			}
		} finally {
			process.off('uncaughtException', onUncaught)
		}

		expect(uncaught).toEqual([])
	})
})
