import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'

// Loaded by path so the package's tsconfig does not pull the repo script in.
const scriptPath = fileURLToPath(
	new URL('../../../../scripts/check-no-payment-mocks.mjs', import.meta.url),
)
const { findMockLeaks, MOCK_NEEDLES } = (await import(scriptPath)) as {
	findMockLeaks(directory: string): Array<{ file: string; needle: string }>
	MOCK_NEEDLES: string[]
}

const entry = fileURLToPath(
	new URL('./fixtures/exclusion-entry.ts', import.meta.url),
)

async function bundle(bundled: boolean) {
	const build = await rolldown({
		input: entry,
		platform: 'node',
		external: [/^node:/, 'stripe', 'checkout-sdk-node'],
		logLevel: 'silent',
		// The same define the App's vite config sets (vite 8 builds with rolldown).
		transform: { define: { __PAYMENTS_MOCK_BUNDLED__: String(bundled) } },
	})
	const { output } = await build.generate({ format: 'esm' })
	return output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')
}

describe('production exclusion: build-time define (build-time define and CI scan)', () => {
	it('keeps the emulator and its sentinel when the define is true (Node/CI build)', async () => {
		const code = await bundle(true)
		expect(code).toContain('__PAYMENTS_MOCK__')
		expect(code).toContain('checkout-com.mock.invalid')
	})

	it('removes the emulator, sentinel, hosts and tables when the define is false (build:cf)', async () => {
		const code = await bundle(false)
		for (const needle of MOCK_NEEDLES) expect(code).not.toContain(needle)
		expect(code).not.toContain('sk_test_mock_platform')
		expect(code).not.toContain('createPaymentsEmulator')
	})

	it('the CI scanner flags a leaked bundle and passes a clean one', async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
		const { tmpdir } = await import('node:os')
		const { join } = await import('node:path')
		const dirty = mkdtempSync(join(tmpdir(), 'mock-leak-'))
		writeFileSync(join(dirty, 'server.js'), await bundle(true))
		const leaks = findMockLeaks(dirty)
		expect(leaks.map((leak) => leak.needle)).toEqual(
			expect.arrayContaining([
				'__PAYMENTS_MOCK__',
				'checkout-com.mock.invalid',
			]),
		)
		const clean = mkdtempSync(join(tmpdir(), 'mock-clean-'))
		mkdirSync(join(clean, 'assets'))
		writeFileSync(join(clean, 'assets', 'index.js'), await bundle(false))
		expect(findMockLeaks(clean)).toEqual([])
	})

	it('the CLI exits 1 on a leaked bundle and 0 on a clean one', async () => {
		const { spawnSync } = await import('node:child_process')
		const { mkdtempSync, writeFileSync } = await import('node:fs')
		const { tmpdir } = await import('node:os')
		const { join } = await import('node:path')
		const dirty = mkdtempSync(join(tmpdir(), 'mock-cli-dirty-'))
		writeFileSync(join(dirty, 'server.js'), 'const a = "__PAYMENTS_MOCK__"')
		const clean = mkdtempSync(join(tmpdir(), 'mock-cli-clean-'))
		writeFileSync(join(clean, 'server.js'), 'const a = 1')
		expect(spawnSync('node', [scriptPath, dirty]).status).toBe(1)
		expect(spawnSync('node', [scriptPath, clean]).status).toBe(0)
		expect(spawnSync('node', [scriptPath, join(clean, 'missing')]).status).toBe(
			1,
		)
	})
})
