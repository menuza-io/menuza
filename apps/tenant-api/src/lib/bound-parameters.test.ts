import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Durable Object SQLite allows 100 bound parameters per statement. A raw
 * `inArray(column, list)` over data-sized input silently works on a small
 * database and fails in production. Every `inArray(` call in tenant-api must
 * therefore either
 *  - run inside `queryInChunks` / `forEachInChunks` / a `chunkIds(...)` loop
 *    (list is a chunk of at most `MAX_IN_CHUNK`),
 *  - take a literal or `as const` list, or
 *  - carry a `// bounded: <why>` comment on the line above or the same line.
 */
const SRC = path.resolve(import.meta.dirname, '..')
const CHUNK_HELPERS = new Set(['queryInChunks', 'forEachInChunks'])

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			out.push(...sourceFiles(full))
		} else if (
			full.endsWith('.ts') &&
			!full.endsWith('.test.ts') &&
			!full.endsWith('.d.ts')
		) {
			out.push(full)
		}
	}
	return out
}

function isInsideChunkLoop(node: ts.Node): boolean {
	for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
		if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression)) {
			if (CHUNK_HELPERS.has(cur.expression.text)) return true
		}
		if (ts.isForOfStatement(cur)) {
			const expr = cur.expression
			if (
				ts.isCallExpression(expr) &&
				ts.isIdentifier(expr.expression) &&
				expr.expression.text === 'chunkIds'
			) {
				return true
			}
		}
	}
	return false
}

const CHUNK_LOOP_CALLS = new Set(['chunk', 'chunked', 'chunkIds'])

/**
 * `part` / `chunk` loop variables: `for (const part of chunk(ids, N))` or an
 * arrow parameter named `chunk` handed to a chunking helper. The size limits
 * are asserted below, not here.
 */
function isChunkVariable(node: ts.CallExpression): boolean {
	const list = node.arguments[1]
	if (!list || !ts.isIdentifier(list)) return false
	for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
		if (
			ts.isForOfStatement(cur) &&
			ts.isVariableDeclarationList(cur.initializer) &&
			cur.initializer.declarations.some(
				(d) => ts.isIdentifier(d.name) && d.name.text === list.text,
			) &&
			ts.isCallExpression(cur.expression) &&
			ts.isIdentifier(cur.expression.expression) &&
			CHUNK_LOOP_CALLS.has(cur.expression.expression.text)
		) {
			return true
		}
		if (
			(ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
			list.text === 'chunk' &&
			cur.parameters.some(
				(p) => ts.isIdentifier(p.name) && p.name.text === 'chunk',
			)
		) {
			return true
		}
	}
	return false
}

function hasBoundedComment(text: string, sf: ts.SourceFile, node: ts.Node) {
	const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
	const lines = text.split('\n')
	for (let l = line; l >= Math.max(0, line - 3); l--) {
		if (/\/\/\s*bounded:/.test(lines[l] ?? '')) return true
		if (l < line && !/^\s*(\/\/|\.|\)|\()/.test(lines[l] ?? '')) {
			// stop at the first unrelated statement line above
			if (!/\/\//.test(lines[l] ?? '')) break
		}
	}
	return false
}

export function findUnboundedInArray(): string[] {
	const offenders: string[] = []
	for (const file of sourceFiles(SRC)) {
		const text = fs.readFileSync(file, 'utf8')
		if (!text.includes('inArray(')) continue
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
		const visit = (node: ts.Node) => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'inArray'
			) {
				const list = node.arguments[1]
				const array = list && ts.isAsExpression(list) ? list.expression : list
				// A fixed literal, or a SCREAMING_CASE constant, has a known size;
				// a spread of anything else makes it data-sized.
				const isConst = (e: ts.Expression) =>
					ts.isIdentifier(e) && /^[A-Z][A-Z0-9_]+$/.test(e.text)
				const literal =
					array !== undefined &&
					(isConst(array) ||
						(ts.isArrayLiteralExpression(array) &&
							array.elements.every(
								(e) => !ts.isSpreadElement(e) || isConst(e.expression),
							)))
				if (
					!literal &&
					!isInsideChunkLoop(node) &&
					!isChunkVariable(node) &&
					!hasBoundedComment(text, sf, node)
				) {
					const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
					offenders.push(`${path.relative(SRC, file)}:${line + 1}`)
				}
			}
			ts.forEachChild(node, visit)
		}
		visit(sf)
	}
	return offenders
}

/**
 * A chunk of up to 90 ids bound twice in one statement is 180 parameters. A
 * chunk variable may therefore appear in only one `inArray` per statement
 * (use `inJsonList` for the second predicate, or a smaller chunk with a
 * `// bounded:` note).
 */
export function findReusedChunkList(
	files: Array<{ file: string; text: string }> = sourceFiles(SRC).map(
		(file) => ({ file, text: fs.readFileSync(file, 'utf8') }),
	),
): string[] {
	const offenders: string[] = []
	for (const { file, text } of files) {
		if (!text.includes('inArray(')) continue
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
		const statementOf = (node: ts.Node): ts.Node => {
			let cur = node
			while (cur.parent && !ts.isStatement(cur)) cur = cur.parent
			return cur
		}
		const seen = new Map<string, number>()
		const calls: ts.CallExpression[] = []
		const visit = (node: ts.Node) => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'inArray' &&
				node.arguments[1] &&
				ts.isIdentifier(node.arguments[1])
			) {
				calls.push(node)
			}
			ts.forEachChild(node, visit)
		}
		visit(sf)
		for (const call of calls) {
			const list = (call.arguments[1] as ts.Identifier).text
			const stmt = statementOf(call)
			const key = `${stmt.pos}:${list}`
			seen.set(key, (seen.get(key) ?? 0) + 1)
			if (seen.get(key) === 2 && !hasBoundedComment(text, sf, call)) {
				const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf))
				offenders.push(`${path.relative(SRC, file)}:${line + 1}`)
			}
		}
	}
	return offenders
}

describe('tenant-api statements stay under the 100 bound-parameter limit', () => {
	it('has no unchunked inArray over unbounded lists', () => {
		expect(findUnboundedInArray()).toEqual([])
	})

	it('never binds one chunk of ids twice in a statement', () => {
		expect(findReusedChunkList()).toEqual([])
	})

	it('flags a list reused in one statement (scanner self-test)', () => {
		const bad = `async function f(db) {
			for (const part of chunk(ids, 90)) {
				await db.select().where(or(inArray(a, part), inArray(b, part)))
			}
		}`
		const good = bad.replace('inArray(b, part)', 'inJsonList(b, ids)')
		expect(
			findReusedChunkList([{ file: path.join(SRC, 'x.ts'), text: bad }]),
		).toHaveLength(1)
		expect(
			findReusedChunkList([{ file: path.join(SRC, 'x.ts'), text: good }]),
		).toEqual([])
	})

	it('keeps every chunk size constant and literal at 90 or less', () => {
		const tooBig: string[] = []
		for (const file of sourceFiles(SRC)) {
			const text = fs.readFileSync(file, 'utf8')
			const rel = path.relative(SRC, file)
			for (const m of text.matchAll(
				/\b(?:const|let)\s+([A-Z_]*CHUNK[A-Z_]*)\s*=\s*(\d+)/g,
			)) {
				if (Number(m[2]) > 90) tooBig.push(`${rel}: ${m[1]} = ${m[2]}`)
			}
			for (const m of text.matchAll(/\bchunk(?:ed)?\([^()]*,\s*(\d+)\)/g)) {
				if (Number(m[1]) > 90) tooBig.push(`${rel}: chunk(..., ${m[1]})`)
			}
			for (const m of text.matchAll(/\bi\s*\+=\s*(\d+)\)/g)) {
				if (Number(m[1]) > 90) tooBig.push(`${rel}: step ${m[1]}`)
			}
		}
		expect(tooBig).toEqual([])
	})
})
