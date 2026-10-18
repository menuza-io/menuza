import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SITES_ROOT = join(import.meta.dirname, '..', '..')
const SKIP = new Set(['node_modules', 'dist', '.wrangler', '.astro', '.git'])
const SELF = join(import.meta.dirname, 'no-internal-token.test.ts')

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue
		const path = join(dir, name)
		if (statSync(path).isDirectory()) yield* walk(path)
		else yield path
	}
}

describe('Sites never holds the platform command token', () => {
	it('has no INTERNAL_COMMAND_TOKEN reference in apps/sites source or schema', () => {
		const hits: string[] = []
		for (const file of walk(SITES_ROOT)) {
			if (file === SELF || /\.(png|jpe?g|webp|woff2?|ico|svg)$/.test(file))
				continue
			// env.d.ts is generated and gitignored.
			if (file.endsWith('env.d.ts')) continue
			if (readFileSync(file, 'utf8').includes('INTERNAL_COMMAND_TOKEN')) {
				hits.push(file)
			}
		}
		expect(hits).toEqual([])
	})
})
