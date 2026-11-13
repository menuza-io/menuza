import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guest names, emails and phones live in the organization's region and reach
 * the operator UI only browser-direct (docs/tenant-data-residency.md). No App
 * server code under `marketing+/` may read a tenant-api response that carries
 * them: the campaign detail (its recipient list), journey runs or a run's
 * timeline. Those pages mint a Marketing token and fetch from the browser; the
 * server may read the PII-free campaign `/summary` and the journey definition.
 */

const MARKETING_ROUTES = path.resolve(
	import.meta.dirname,
	'../../routes/_app+/$orgSlug_+/marketing+',
)

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

function violations(source: string): string[] {
	return fetchTenantPaths(source).flatMap((arg) => {
		if (!/^[`'"]/.test(arg)) return [`unchecked path expression: ${arg}`]
		return FORBIDDEN_SERVER_PATHS.filter(({ pattern }) =>
			pattern.test(arg),
		).map(({ label }) => `${label}: ${arg}`)
	})
}

function routeFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) return routeFiles(full)
		return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')
			? [full]
			: []
	})
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
		'%s calls fetchTenant only on PII-free tenant-api paths',
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
