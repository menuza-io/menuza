import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			'~': path.resolve(import.meta.dirname, './src'),
			// Same bridge the Astro build uses: frontmatter cannot run Babel macros.
			'@lingui/core/macro': path.resolve(
				import.meta.dirname,
				'./src/lib/lingui-macro-runtime.ts',
			),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},
})
