import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type RouteEntry = { file: string; children?: RouteEntry[] }

afterEach(() => {
	vi.unstubAllEnvs()
	vi.resetModules()
})

function flatten(entries: readonly RouteEntry[]): RouteEntry[] {
	return entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])])
}

async function routeFiles(stripDevMocks: boolean) {
	vi.resetModules()
	vi.stubEnv('STRIP_DEV_MOCKS', stripDevMocks ? 'true' : '')
	const config = await (await import('./routes.ts')).default
	return flatten(config as RouteEntry[]).map((entry) => entry.file)
}

describe('dev mock route folders', () => {
	it('are routes in dev and in a plain build', async () => {
		const files = await routeFiles(false)
		expect(files).toEqual(
			expect.arrayContaining([
				'routes/mock-email+/_index.ts',
				'routes/mock-email+/dev.messages.ts',
				'routes/mock-email+/dev.reset.ts',
			]),
		)
	})

	it('are left out of a build with STRIP_DEV_MOCKS=true, and nothing else is', async () => {
		const withMocks = await routeFiles(false)
		const stripped = await routeFiles(true)
		expect(stripped.filter((file) => file.includes('mock-email+'))).toEqual([])
		expect(stripped.filter((file) => file.includes('mock-payments+'))).toEqual(
			[],
		)
		const removed = withMocks.filter((file) => !stripped.includes(file))
		expect(removed.length).toBeGreaterThanOrEqual(3)
		expect(
			removed.every(
				(file) =>
					file.includes('mock-email+') || file.includes('mock-payments+'),
			),
		).toBe(true)
	})
})

describe('production builds strip the dev mocks', () => {
	const repoRoot = path.resolve(import.meta.dirname, '../../..')
	const read = (relative: string) =>
		fs.readFileSync(path.join(repoRoot, relative), 'utf8')

	it('sets STRIP_DEV_MOCKS in build:cf', () => {
		const pkg = JSON.parse(read('apps/app/package.json')) as {
			scripts: Record<string, string>
		}
		expect(pkg.scripts['build:cf']).toContain('STRIP_DEV_MOCKS=true')
		expect(pkg.scripts['build']).not.toContain('STRIP_DEV_MOCKS')
		expect(pkg.scripts['dev']).not.toContain('STRIP_DEV_MOCKS')
	})

	it('sets it for the CI deploy build of the App and lets turbo pass it', () => {
		expect(read('scripts/cf-workers-ci.mjs')).toMatch(
			/app: \{[\s\S]*?buildEnv: \{[^}]*STRIP_DEV_MOCKS: 'true'/,
		)
		const turbo = JSON.parse(read('turbo.json')) as {
			tasks: Record<string, { env?: string[] }>
		}
		expect(turbo.tasks['app#build']?.env).toContain('STRIP_DEV_MOCKS')
	})

	it('keeps the capture module out of the Node server entry', () => {
		const nodeEntries = ['index.ts', 'server/app.ts']
		for (const entry of nodeEntries) {
			const file = path.join(repoRoot, 'apps/app', entry)
			if (!fs.existsSync(file)) continue
			expect(fs.readFileSync(file, 'utf8')).not.toContain('dev-email-capture')
		}
	})
})
