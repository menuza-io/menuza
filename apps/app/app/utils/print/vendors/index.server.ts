import { vendorEnv } from './env.server.ts'
import { gelatoVendor } from './gelato.server.ts'
import { createMockVendor } from './mock.server.ts'
import { prodigiVendor } from './prodigi.server.ts'
import { type PrintVendor, type PrintVendorName } from './types.ts'

const ON = new Set(['1', 'true', 'yes', 'on'])

function isLocalOrigin(value: string | undefined) {
	try {
		const host = new URL(value ?? '').hostname
		return (
			host === 'localhost' ||
			host === '127.0.0.1' ||
			host === '::1' ||
			host.endsWith('.localhost') ||
			host.endsWith('.test')
		)
	} catch {
		return false
	}
}

/**
 * The emulator only ever runs on a local deployment: with a public BASE_URL a
 * stray `PRINT_MOCK=true` is ignored, so real orders can never be faked.
 */
export function isPrintMock(): boolean {
	return (
		ON.has(vendorEnv('PRINT_MOCK').toLowerCase()) &&
		isLocalOrigin(vendorEnv('BASE_URL'))
	)
}

/** The adapter for a catalog vendor; the emulator stands in under PRINT_MOCK. */
export function getPrintVendor(name: PrintVendorName): PrintVendor {
	if (isPrintMock() || name === 'mock') return createMockVendor(name)
	return name === 'gelato' ? gelatoVendor : prodigiVendor
}
