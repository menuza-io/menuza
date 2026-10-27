import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * QR ordering security sweep (App side): every loader and action under
 * `qr+/`, the QR pages under `settings+/` and the `qr-token` route call
 * `requireQrOrderingAccess` before they await anything else, so the flag
 * (404), the menu permission (403) and sign-in (401) answer first. The token route asks for write access exactly
 * when it mints `qr:write`.
 */

const ORG_ROUTES = path.resolve(
	import.meta.dirname,
	'../../routes/_app+/$orgSlug_+',
)
const QR_ROUTES = path.join(ORG_ROUTES, 'qr+')

function exportedFunctionBody(source: string, name: string): string | null {
	const start = source.search(
		new RegExp(`export (async )?function ${name}\\s*\\(`),
	)
	if (start === -1) return null
	const open = source.indexOf('{', source.indexOf(')', start))
	let depth = 0
	for (let index = open; index < source.length; index += 1) {
		const char = source[index]
		if (char === '{') depth += 1
		if (char === '}') {
			depth -= 1
			if (depth === 0) return source.slice(open + 1, index)
		}
	}
	return null
}

const files = [
	...fs
		.readdirSync(QR_ROUTES)
		.filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.'))
		.map((file) => path.join(QR_ROUTES, file)),
	path.join(ORG_ROUTES, 'qr-token.ts'),
	// The QR pages live under Settings.
	path.join(ORG_ROUTES, 'settings+', 'qr-tables.tsx'),
	path.join(ORG_ROUTES, 'settings+', 'qr-ordering.tsx'),
].sort()

describe('QR ordering guards', () => {
	it('finds the QR routes', () => {
		const names = files.map((file) => path.basename(file))
		expect(names).toEqual(
			expect.arrayContaining([
				'_layout.tsx',
				'_index.tsx',
				'tables.tsx',
				'settings.tsx',
				'qr-token.ts',
				'qr-tables.tsx',
				'qr-ordering.tsx',
			]),
		)
	})

	it.each(files.map((file) => [path.basename(file), file]))(
		'%s guards every loader and action first',
		(_name, file) => {
			const source = fs.readFileSync(file, 'utf8')
			for (const name of ['loader', 'action'] as const) {
				const body = exportedFunctionBody(source, name)
				if (body === null) continue
				const firstAwait = body.match(/await\s+([A-Za-z_$][\w$]*)\(/)
				expect(firstAwait?.[1], `${file} ${name}`).toBe(
					'requireQrOrderingAccess',
				)
			}
		},
	)

	it('mints qr:write only after a write check', () => {
		const source = fs.readFileSync(path.join(ORG_ROUTES, 'qr-token.ts'), 'utf8')
		expect(source).toMatch(/requireQrOrderingAccess\([^)]*\{\s*write,?\s*\}/s)
		expect(source).toMatch(/scope:\s*write \? 'qr:write' : 'qr:read'/)
		expect(source).toMatch(/write && access\.floorPlanAvailable/)
	})
})
