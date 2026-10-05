import * as nodeCrypto from 'node:crypto'

const webCrypto: Crypto | undefined =
	(typeof globalThis.crypto !== 'undefined' &&
	typeof globalThis.crypto.getRandomValues === 'function'
		? globalThis.crypto
		: (nodeCrypto as { webcrypto?: Crypto }).webcrypto) ?? undefined

if (
	webCrypto &&
	typeof (nodeCrypto as { getRandomValues?: unknown }).getRandomValues !==
		'function'
) {
	try {
		Reflect.set(
			nodeCrypto,
			'getRandomValues',
			webCrypto.getRandomValues.bind(webCrypto),
		)
	} catch {
		// Ignore if non-extensible in runtime
	}
}
