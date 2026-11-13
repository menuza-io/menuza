import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guest names, emails and phones live in the organization's region and reach
 * the operator UI only browser-direct (docs/tenant-data-residency.md). No App
 * server code under `marketing+/` may read a tenant-api response that carries
 * them: the campaign detail (its recipient list), journey runs or a run's
 * timeline. Those pages mint a browser token and fetch from the browser; the
 * server may read the PII-free campaign `/summary` and the journey definition.
 *
 * Checked as server code: every part of a route file except its default
 * export (the page component, which runs in the browser), and every
 * `*.server.ts` module a marketing route imports or that lives in
 * `utils/marketing/`. In those, a forbidden path in any string is refused
 * (a direct `fetch` with the token too), and `fetchTenant` must be given a
 * literal path so it can be checked.
 */

const APP_ROOT = path.resolve(import.meta.dirname, '../..')
const MARKETING_ROUTES = path.join(
	APP_ROOT,
	'routes/_app+/$orgSlug_+/marketing+',
)
const MARKETING_UTILS = path.join(APP_ROOT, 'utils/marketing')

/** tenant-api paths whose responses carry guest contacts or guest-linked runs. */
const FORBIDDEN_SERVER_PATHS: Array<{ label: string; pattern: RegExp }> = [
	{
		label: 'campaign detail (recipients)',
		// `/operator/marketing/campaigns/<id>` with nothing after the id; the
		// `/summary` sub-route is allowed.
		pattern:
			/\/operator\/marketing\/campaigns\/(?:\$\{[^}]+\}|[^/`'"?\s$]+)[`'"?]/,
	},
	{
		label: 'journey runs',
		pattern: /\/operator\/journeys\/(?:\$\{[^}]+\}|[^/`'"?\s]+)\/runs\b/,
	},
	{
		label: 'journey run timeline',
		pattern: /\/operator\/journeys\/runs\//,
	},
	{ label: 'customers', pattern: /\/operator\/customers\b/ },
]

/** The first argument of every `fetchTenant(...)` call in a source file. */
function fetchTenantPaths(source: string): string[] {
	const paths: string[] = []
	const call = /fetchTenant\s*\(\s*/g
	let match: RegExpExecArray | null
	while ((match = call.exec(source))) {
		const start = match.index + match[0].length
		const quote = source[start]
		if (quote !== '`' && quote !== "'" && quote !== '"') {
			// A path built elsewhere cannot be checked here; refuse it.
			paths.push(source.slice(start, source.indexOf(')', start)))
			continue
		}
		let depth = 0
		let end = start + 1
		for (; end < source.length; end += 1) {
			const char = source[end]
			if (quote === '`' && char === '$' && source[end + 1] === '{') depth += 1
			if (quote === '`' && char === '}' && depth > 0) depth -= 1
			if (char === quote && depth === 0 && source[end - 1] !== '\\') break
		}
		paths.push(source.slice(start, end + 1))
	}
	return paths
}

/** Every forbidden path named anywhere in `source` (any string, any call). */
function forbiddenPaths(source: string): string[] {
	return FORBIDDEN_SERVER_PATHS.flatMap(({ label, pattern }) =>
		[...source.matchAll(new RegExp(pattern.source, 'g'))].map(
			(match) => `${label}: ${match[0]}`,
		),
	)
}

function violations(serverSource: string): string[] {
	const unchecked = fetchTenantPaths(serverSource)
		.filter((arg) => !/^[`'"]/.test(arg))
		.map((arg) => `unchecked path expression: ${arg}`)
	return [...unchecked, ...forbiddenPaths(serverSource)]
}

/**
 * A route file without its default export, the page component that runs in
 * the browser. Prettier puts the closing brace of a top-level function at the
 * start of a line, which ends the component.
 */
function serverPart(source: string): string {
	const start = source.search(/^export default function\b/m)
	if (start === -1) return source
	const close = source.indexOf('\n}', start)
	const end = close === -1 ? source.length : close + 2
	return source.slice(0, start) + source.slice(end)
}

function sourceFiles(dir: string, match: RegExp): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) return sourceFiles(full, match)
		return match.test(entry.name) && !entry.name.includes('.test.')
			? [full]
			: []
	})
}

function routeFiles(dir: string): string[] {
	return sourceFiles(dir, /\.tsx?$/)
}

/** `*.server.ts` modules the marketing routes import, plus `utils/marketing`. */
function serverModules(routes: string[]): string[] {
	const imported = routes.flatMap((file) =>
		[
			...fs
				.readFileSync(file, 'utf8')
				.matchAll(/from '#app\/([^']+\.server\.ts)'/g),
		].map((match) => path.join(APP_ROOT, match[1]!)),
	)
	const local = sourceFiles(MARKETING_UTILS, /\.server\.ts$/)
	return [...new Set([...imported, ...local])].sort()
}

describe('marketing+ never reads guest contacts on the App server', () => {
	const files = routeFiles(MARKETING_ROUTES)

	it('finds the marketing routes', () => {
		const names = files.map((file) => path.basename(file))
		expect(names).toEqual(
			expect.arrayContaining([
				'campaigns.$campaignId.tsx',
				'automations.$journeyId.runs.tsx',
				'automations.$journeyId.tsx',
			]),
		)
	})

	it.each(files.map((file) => [path.basename(file), file]))(
		'%s reads only PII-free tenant-api paths on the server',
		(_name, file) => {
			expect(violations(serverPart(fs.readFileSync(file, 'utf8')))).toEqual([])
		},
	)

	const modules = serverModules(files)

	it('finds the server modules the marketing routes use', () => {
		expect(modules.map((file) => path.relative(APP_ROOT, file))).toEqual(
			expect.arrayContaining([
				'utils/tenant-api.server.ts',
				'utils/marketing/reservation-triggers.server.ts',
			]),
		)
	})

	it.each(modules.map((file) => [path.relative(APP_ROOT, file), file]))(
		'%s reads only PII-free tenant-api paths',
		(_name, file) => {
			expect(violations(fs.readFileSync(file, 'utf8'))).toEqual([])
		},
	)

	it('catches the calls these pages used to make', () => {
		const before = `
			fetchTenant(\`/operator/marketing/campaigns/\${encodeURIComponent(campaignId)}\`)
			fetchTenant(\`/operator/journeys/\${journeyId}/runs\`)
			fetchTenant(\`/operator/journeys/runs/\${encodeURIComponent(runId)}\`)
			fetchTenant(path)
		`
		expect(violations(before)).toHaveLength(4)
	})

	it('catches a direct fetch with the token in server code', () => {
		const loader = `
			export async function loader() {
				const { jwt, tenantApiUrl } = await getOperatorTenantClient(request, orgSlug, { area: 'marketing' })
				await fetch(\`\${tenantApiUrl}/operator/marketing/campaigns/\${id}\`, { headers: { Authorization: \`Bearer \${jwt}\` } })
			}
		`
		expect(violations(serverPart(loader))).toHaveLength(1)
	})

	it('leaves the browser fetch in the page component alone', () => {
		// Top-level code starts at column 0, as Prettier writes route files.
		const route = [
			'export async function loader() {',
			'\treturn { jwt }',
			'}',
			'export default function Page() {',
			'\tuseEffect(() => {',
			'\t\tvoid fetch(`${tenantApiUrl}/operator/journeys/runs/${id}`)',
			'\t}, [])',
			'\treturn null',
			'}',
			'function helper() {',
			'\treturn fetch(`${tenantApiUrl}/operator/journeys/${id}/runs`)',
			'}',
		].join('\n')
		// The helper after the component is still server-side code.
		expect(violations(serverPart(route))).toEqual([
			'journey runs: /operator/journeys/${id}/runs',
		])
	})

	it('allows the summary, the list and the journey definition', () => {
		const allowed = `
			fetchTenant(\`/operator/marketing/campaigns/\${encodeURIComponent(campaignId)}/summary\`)
			fetchTenant('/operator/marketing/campaigns')
			fetchTenant(\`/operator/journeys/\${encodeURIComponent(journeyId)}\`)
			fetchTenant(\`/operator/journeys/\${journeyId}/publish\`, { method: 'POST' })
		`
		expect(violations(allowed)).toEqual([])
	})
})
