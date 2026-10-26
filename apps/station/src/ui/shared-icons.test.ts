import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const src = new URL('../', import.meta.url)
const glyphs = new URL('../../../packages/ui/other/svg-icons/', src)
const sprite = readFileSync(
	new URL('../../../packages/ui/components/icons/sprite.svg', src),
	'utf8',
)
const names = new Set(
	readdirSync(glyphs)
		.filter((name) => name.endsWith('.svg'))
		.map((name) => name.slice(0, -4)),
)

function filesIn(folder: URL): URL[] {
	return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), folder)
		return entry.isDirectory()
			? filesIn(url)
			: entry.name.endsWith('.tsx')
				? [url]
				: []
	})
}

describe('Station uses the shared icon and native-select contracts everywhere', () => {
	it('insets painted pills, not their touch targets, in both tab implementations', () => {
		const css = readFileSync(new URL('styles/app.css', src), 'utf8')
		const header = readFileSync(
			new URL('apps/reservations/StandHeader.tsx', src),
			'utf8',
		)
		expect(css.match(/\.t-tabs-pill::before\s*\{([^}]+)}/)?.[1]).toContain(
			'inset: 0.25rem 0;',
		)
		// The host stand's tabs (utilities): the group pads its sides only, each tab keeps 44px.
		const group = header.match(/'bk-tabs ([^']+)'/)?.[1]?.split(' ') ?? []
		expect(group).toContain('px-1')
		expect(group.filter((c) => /^(p|py|pt|pb)-/.test(c))).toEqual([])
		expect(header.match(/"bk-tab ([^"]+)"/)?.[1]?.split(' ')).toContain(
			'min-h-11',
		)
	})
	it.each(filesIn(src).map((url) => [fileURLToPath(url), url] as const))(
		'%s',
		(path, url) => {
			const source = readFileSync(url, 'utf8')
			const tree = ts.createSourceFile(
				path,
				source,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX,
			)
			const sharedImport = tree.statements.find(
				(node) =>
					ts.isImportDeclaration(node) &&
					node.moduleSpecifier.getText(tree) === "'@repo/ui/icon'",
			)
			const checkName = (name: string) => {
				expect(names.has(name), `Missing shared SVG: ${name}`).toBe(true)
				expect(sprite, `Missing sprite symbol: ${name}`).toContain(
					`<symbol id="${name}" `,
				)
			}
			function visit(node: ts.Node) {
				if (ts.isImportDeclaration(node)) {
					expect(node.moduleSpecifier.getText(tree)).not.toMatch(
						/lucide|react-icons|heroicons/,
					)
				}
				if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
					const tag = node.tagName.getText(tree)
					// QR codes and floor-plan media are not icon markup. Neither currently uses a raw SVG.
					expect(
						tag,
						'Glyphs must use @repo/ui/icon, not duplicate SVG paths',
					).not.toBe('svg')
					if (tag === 'select')
						expect(path.endsWith('/ui/primitives.tsx')).toBe(true)
					if (tag === 'Icon')
						expect(
							sharedImport,
							'Import Icon directly from @repo/ui/icon',
						).toBeDefined()
					for (const attribute of node.attributes.properties) {
						if (
							!ts.isJsxAttribute(attribute) ||
							!['name', 'icon'].includes(attribute.name.getText(tree))
						)
							continue
						if (attribute.name.getText(tree) === 'name' && tag !== 'Icon')
							continue
						const value = attribute.initializer
						if (value && ts.isStringLiteral(value)) checkName(value.text)
						else if (
							value &&
							ts.isJsxExpression(value) &&
							value.expression &&
							ts.isStringLiteral(value.expression)
						)
							checkName(value.expression.text)
					}
				}
				if (
					ts.isPropertyAssignment(node) &&
					node.name.getText(tree) === 'icon'
				) {
					const value = ts.isAsExpression(node.initializer)
						? node.initializer.expression
						: node.initializer
					if (ts.isStringLiteral(value)) checkName(value.text)
				}
				if (
					ts.isVariableDeclaration(node) &&
					/_ICON$/.test(node.name.getText(tree)) &&
					node.initializer &&
					ts.isObjectLiteralExpression(node.initializer)
				) {
					for (const property of node.initializer.properties)
						if (
							ts.isPropertyAssignment(property) &&
							ts.isStringLiteral(property.initializer)
						)
							checkName(property.initializer.text)
				}
				ts.forEachChild(node, visit)
			}
			visit(tree)
		},
	)
})
