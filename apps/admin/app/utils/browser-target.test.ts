import { transformWithEsbuild } from 'vite'
import { expect, it } from 'vitest'
import viteConfig from '../../vite.config.ts'

it('uses the production target when prebundling Admin dependencies', async () => {
	const config = await viteConfig({ command: 'serve', mode: 'test' })
	const target = config.optimizeDeps?.esbuildOptions?.target
	expect(target).toBe('es2022')
	expect(target).toBe(config.build?.target)
	await expect(
		transformWithEsbuild(
			'const [item] = items; const { name, ...rest } = item;',
			'admin-browser-target-regression.js',
			{ target: target as string },
		),
	).resolves.toHaveProperty('code')
})
