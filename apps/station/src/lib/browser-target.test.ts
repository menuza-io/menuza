import { fileURLToPath } from 'node:url'
import { resolveConfig, transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'

const configFile = fileURLToPath(
	new URL('../../vite.config.ts', import.meta.url),
)

describe('Station browser compatibility targets', () => {
	it.each(['serve', 'build'] as const)(
		'bundles destructuring for %s with the installed compiler',
		async (command) => {
			const config = await resolveConfig({ configFile, mode: 'test' }, command)
			expect(config.optimizeDeps.esbuildOptions?.target).toEqual(
				config.build.target,
			)
			const target =
				command === 'serve'
					? (config.optimizeDeps.esbuildOptions?.target ?? config.build.target)
					: config.build.target
			expect(target).toContain('safari15')
			expect(target).not.toContain('safari14')
			await expect(
				transformWithEsbuild(
					'const [item] = items; const { name, ...rest } = item;',
					'browser-target-regression.js',
					{ target: target as string[] },
				),
			).resolves.toHaveProperty('code')
		},
	)
})
