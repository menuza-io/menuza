/**
 * Wraps a `ReadableStream` so that canceling it never cancels the underlying
 * source: the remainder is drained (and discarded) instead.
 *
 * This works around a Node.js bug where canceling a stream created with
 * `Readable.toWeb()` can throw an uncatchable `ERR_INVALID_STATE: Controller is
 * already closed` from inside Node's stream adapter and kill the process.
 *
 * The web stream is marked as closed as soon as it is canceled, but the
 * `'data'` listener the adapter attached to the Node stream is only removed
 * once `destroy()` takes effect, so a `resume_` tick that was already scheduled
 * (very common while streaming under backpressure) delivers one more chunk into
 * the closed controller. See https://github.com/nodejs/node/issues/64529.
 *
 * Draining instead of canceling lets the Node stream end normally, and Node's
 * adapter then closes the web stream itself.
 */
export function drainOnCancel(
	source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const reader = source.getReader()

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read()
			if (done) {
				controller.close()
				return
			}
			controller.enqueue(value)
		},
		async cancel() {
			try {
				while (!(await reader.read()).done) {
					// Discard the remainder so the underlying stream can finish.
				}
			} catch {
				// The source failed while draining; the response is already gone.
			}
		},
	})
}
