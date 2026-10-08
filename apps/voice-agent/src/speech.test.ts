import { ReadableStream } from 'node:stream/web'
import { describe, expect, it } from 'vitest'
import { complianceNotice } from './messages.ts'
import { pronunciationTransform, VerbatimSpeech } from './speech.ts'

const PRONUNCIATIONS = [
	{ term: 'assistant', sayAs: 'uh-SIS-tunt' },
	{ term: 'recorded', sayAs: 'ree-KOR-did' },
	{ term: 'Gnocchi', sayAs: 'nyoh-kee' },
]

function streamOf(chunks: string[]) {
	return new ReadableStream<string>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk)
			controller.close()
		},
	})
}

async function read(stream: ReadableStream<string>) {
	let out = ''
	for await (const chunk of stream) out += chunk
	return out
}

describe('pronunciationTransform', () => {
	it('swaps in spoken forms across streamed tokens', async () => {
		const transform = pronunciationTransform(PRONUNCIATIONS)
		await expect(
			read(transform(streamOf(['Our Gno', 'cchi is great. ', 'Try it']))),
		).resolves.toBe('Our nyoh-kee is great. Try it')
	})

	it('leaves the required notices exactly as written', async () => {
		const verbatim = new VerbatimSpeech()
		const transform = pronunciationTransform(PRONUNCIATIONS, verbatim)
		const notice = complianceNotice({
			language: 'en',
			business: 'Acme',
			recording: true,
		})
		expect(notice).toContain('assistant')
		expect(notice).toContain('recorded')
		verbatim.add(notice)
		await expect(read(transform(streamOf([notice])))).resolves.toBe(notice)
		// Other speech in the same session is still transformed.
		await expect(
			read(transform(streamOf(['Your assistant today. ']))),
		).resolves.toBe('Your uh-SIS-tunt today. ')
	})

	it('only skips a stream that starts with the whole notice', async () => {
		const verbatim = new VerbatimSpeech()
		verbatim.add('I am an assistant.')
		const transform = pronunciationTransform(PRONUNCIATIONS, verbatim)
		await expect(
			read(transform(streamOf(['I am an ', 'assistant.']))),
		).resolves.toBe('I am an uh-SIS-tunt.')
	})
})
