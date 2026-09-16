import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { drainOnCancel } from './drain-on-cancel.server.ts'

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
		const stream = drainOnCancel(Readable.toWeb(source))

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
		const uncaught: Array<Error> = []
		const onUncaught = (error: Error) => uncaught.push(error)
		process.on('uncaughtException', onUncaught)

		try {
			// A slow sink with a small high water mark forces the pause →
			// `pull()` → `resume()` cycles that make the race reproducible.
			for (let iteration = 0; iteration < 100; iteration++) {
				const source = new Readable({
					read() {
						this.push(Buffer.alloc(16 * 1024, 1))
						if ((this.bytes = (this.bytes || 0) + 16_384) > 256 * 1024) {
							this.push(null)
						}
					},
				})
				const passThrough = new PassThrough({ highWaterMark: 16_384 })
				source.pipe(passThrough)

				const stream = drainOnCancel(Readable.toWeb(passThrough))
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
