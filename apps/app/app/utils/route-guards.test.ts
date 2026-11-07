import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * App-wide route guard sweep. It reads every route module under `app/routes`
 * (the files `remix-flat-routes` turns into routes) and fails when an exported
 * `loader` or `action` can run without a server-side check of who is calling:
 *
 *  - every loader and action reaches a recognised guard (a session, an
 *    organization membership, a machine credential, a signature, the dev mock
 *    gate, or `requireAnonymous` for sign-in pages). Guards are found through
 *    local helpers and `#app/...` / relative imports, so wrappers such as
 *    `requireStaffingAccess` or `loadSettingsPage` count when they call one;
 *  - nothing reads the request body, calls `fetch`, or writes to the database
 *    before that first guard call;
 *  - everything under `$orgSlug_+` reaches an organization membership guard,
 *    not just a session check;
 *  - routes that are public on purpose are listed below with their reason, and
 *    the list fails when a listed file disappears or gains a guard everywhere.
 *
 * Narrower sweeps with stricter ordering rules: `staffing/staffing-guards.test.ts`
 * and `print/print-guards.test.ts`.
 */

const APP_DIR = path.resolve(import.meta.dirname, '..')
const ROUTES_DIR = path.join(APP_DIR, 'routes')
const ENTRY_NAMES = ['loader', 'action'] as const

type GuardKind = 'session' | 'membership' | 'machine' | 'anonymous' | 'dev'

/**
 * Terminal guards by name. Each throws (redirect / 401 / 403 / 404) unless the
 * caller is who the name says. Anything else counts only if it calls one.
 */
const BASE_GUARDS: Record<string, GuardKind[]> = {
	// A signed-in operator (cookie session) or a mobile/API bearer token.
	requireUserId: ['session'],
	requireUser: ['session'],
	requireAuth: ['session'],
	requireUserWithRole: ['session'],
	requireUserWithPermission: ['session'],
	requireAnyUserWithPermission: ['session'],
	// An active member of the organization (all of these also need a session).
	requireUserOrganization: ['session', 'membership'],
	requireUserWithOrganizationPermission: ['session', 'membership'],
	requireAnyUserWithOrganizationPermission: ['session', 'membership'],
	requireUserWithOrganizationRole: ['session', 'membership'],
	requireOrganizationMember: ['session', 'membership'],
	requireOrganizationAdmin: ['session', 'membership'],
	userHasOrgAccess: ['session', 'membership'],
	// Settings, Roles: an active membership with the built-in admin role.
	requireBuiltInOrganizationAdmin: ['session', 'membership'],
	checkUserOrganizationAccess: ['membership'],
	// Machine-to-machine credentials and signed requests.
	requireInternalCommandAuth: ['machine'],
	requireVoiceAgentAuth: ['machine'],
	verifyResendWebhook: ['machine'],
	checkoutWebhookSignatureFromRequest: ['machine'],
	verifyMediaSignature: ['machine'],
	validateAccessToken: ['machine'],
	validateApiKey: ['machine'],
	verifyAccessToken: ['machine'],
	verifySitePreviewToken: ['machine'],
	// Sign-in pages that must not run for a signed-in user.
	requireAnonymous: ['anonymous'],
	// Dev-only payment emulator: 404 unless the mock is on and the host is local.
	requirePaymentsMock: ['dev'],
}

/**
 * Public on purpose, by file or by `file#entry`. Each says what protects it
 * instead of a member login.
 */
const PUBLIC_ROUTES: Record<string, string> = {
	'_app+/$orgSlug_+/notes.tsx#action':
		'only sets the caller’s own notes view-mode cookie; reads and writes no data',
	'$.tsx': 'catch-all; loader and action only throw 404',
	'[.]well-known.oauth-authorization-server.ts':
		'OAuth metadata document (RFC 8414), static',
	'[.]well-known.oauth-protected-resource.ts':
		'OAuth protected-resource metadata (RFC 9728), static',
	'_auth+/auth.$provider.callback.ts':
		'OAuth callback; the provider state/code is verified by the authenticator',
	'_auth+/auth.sso.$organizationSlug.callback.ts':
		'SSO callback; the IdP response is verified by the SSO strategy',
	'_auth+/auth.sso.$organizationSlug.logout.ts':
		'SSO logout; only clears the caller’s own session',
	'_auth+/auth.sso.$organizationSlug.ts':
		'starts SSO sign-in for an organization with SSO configured',
	'_auth+/auth_.$provider.ts': 'starts OAuth sign-in with a provider',
	'_auth+/discover-org.ts':
		'login step: finds the SSO organization for an email domain',
	'_auth+/forgot-password.tsx':
		'password reset request; honeypot and rate limit, same answer for any email',
	'_auth+/logout.tsx': 'signs the caller out of their own session',
	'_auth+/signup.tsx': 'sign-up form; honeypot and email verification',
	'_auth+/verify.tsx': 'one-time code verification for signup/reset/2FA',
	'_auth+/webauthn+/authentication.ts':
		'passkey sign-in; the challenge cookie and signed assertion are verified',
	'_app+/index.tsx':
		'`/` redirect: signed out to /signup, signed in to their default organization',
	'_seo+/robots[.]txt.ts': 'robots.txt',
	'_seo+/sitemap[.]xml.ts': 'sitemap of public pages',
	'api+/auth.$provider.callback.ts':
		'mobile OAuth callback; verified by the authenticator',
	'api+/auth.$provider.ts': 'mobile OAuth start',
	'api+/auth.login.2fa.ts': 'mobile 2FA step; verifies the pending 2FA token',
	'api+/auth.login.ts': 'mobile sign-in; checks the password',
	'api+/auth.logout.ts':
		'mobile sign-out; revokes the refresh token it is given',
	'api+/auth.onboarding.ts':
		'mobile onboarding; needs the verified onboarding email session',
	'api+/auth.refresh.ts':
		'mobile token refresh; the refresh token is the credential',
	'api+/auth.signup.ts': 'mobile sign-up; honeypot and email verification',
	'api+/auth.verify.ts': 'mobile one-time code verification',
	'api+/health.ts': 'liveness probe, no data',
	'api+/mock-env.ts':
		'dev switch; 404 unless the host is local and mocks are on',
	// The other handler of each uses the bearer JWT (requireAuth) and is swept.
	'api+/organizations.ts#action': 'only answers 405',
	'api+/profile.ts#loader': 'only answers 405',
	'api+/organizations.create.ts#loader': 'only answers 405',
	'api+/organizations.set-default.ts#loader': 'only answers 405',
	'api+/status.ts': 'public uptime status',
	'api+/stripe+/webhook.tsx':
		'Stripe webhook; stripe-signature verified with the endpoint secret',
	'kiosk.tsx':
		'static shell; the paired device secret is checked by tenant-api',
	'mcp+/_index.ts':
		'MCP endpoint; the action checks the OAuth access token or API key, the loader answers 405',
	'mcp+/authorize.tsx':
		'OAuth consent; redirects to /login without a session, validates client and redirect_uri',
	'mcp+/register.ts':
		'OAuth dynamic client registration (RFC 7591); rate limited',
	'mcp+/token.ts':
		'OAuth token endpoint; the authorization code / refresh token is the credential',
	'my-schedule.tsx': 'static shell; the link token is checked by tenant-api',
	'r+/$code.tsx': 'public referral link redirect',
	'resources+/cookie-consent.ts':
		'sets the caller’s own consent cookie; same-origin check',
	'resources+/fonts.tsx':
		'public site fonts; only keys under org/<id>/site-fonts/',
	'resources+/healthcheck.tsx': 'health check, no data',
	'resources+/print.webhook.$vendor.ts':
		'print vendor webhook; secret token in the URL, only triggers a status fetch',
	'resources+/sidebar-state.ts': 'sets the caller’s own sidebar cookie',
	'resources+/sites.$slug.ts':
		'public published-site data; rate limited, 404 unless published',
	'resources+/sites.careers.ts':
		'public job feed; 404 unless the site is published and staffing.hiring is on',
	'resources+/sites.not-found.ts': 'public site 404 counter; rate limited',
	'resources+/sites.redirect-hit.ts':
		'public site redirect counter; rate limited',
	'resources+/sites.shop.checkout.return.ts':
		'public shop checkout return page for a published shop',
	'resources+/sites.shop.checkout.ts': 'public shop checkout; rate limited',
	'resources+/sites.shop.order.ts':
		'public order status; rate limited, order id plus session check',
	'resources+/sites.shop.payment-intent.ts':
		'public shop payment intent; rate limited',
	'resources+/sites.shop.ts': 'public published shop catalog; rate limited',
	'resources+/sites.ts': 'public published-site lookup by host; rate limited',
	'resources+/theme-switch.tsx': 'sets the caller’s own theme cookie',
	'stop-impersonation.tsx':
		'ends the caller’s own impersonation session (400 when there is none)',
}

/**
 * Entries that hand the guard to a shared handler as a dependency
 * (`{ requireUserId, checkUserOrganizationAccess }`). Checked below.
 */
const GUARD_INJECTED: Record<string, string> = {
	'api+/onboarding+/complete-step.tsx#action':
		'@repo/common handleOnboardingCompleteStep calls deps.requireUserId first',
	'api+/onboarding+/hide.tsx#action':
		'@repo/common handleOnboardingHide calls deps.requireUserId first',
	'api+/onboarding+/progress.tsx#loader':
		'@repo/common handleOnboardingProgress calls deps.requireUserId first',
}

/**
 * Entries that parse the request body before the guard, on purpose. The guard
 * still runs before any read or write.
 */
const BODY_BEFORE_GUARD: Record<string, string> = {
	'_app+/$orgSlug_+/phone-agent+/handling.tsx#action':
		'parses the JSON patch, then saveSettingsPage calls requirePhoneAgentAccess first',
	'_app+/$orgSlug_+/phone-agent+/knowledge.tsx#action':
		'parses the JSON body to pick the intent; each intent calls requirePhoneAgentAccess first',
}

/**
 * Org routes whose membership check happens somewhere the static walk cannot
 * follow. Each has its own check below.
 */
const MEMBERSHIP_DELEGATED: Record<string, string> = {
	'_app+/$orgSlug_+/notes.$noteId.tsx#action':
		'each intent handler in notes.$noteId.server.ts checks the note’s organization',
}

// ---------------------------------------------------------------------------

function routeFiles(): string[] {
	const out: string[] = []
	function walk(directory: string, inFlatFolder: boolean) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				// Only `+` folders hold flat routes; other folders are colocated code.
				if (entry.name.endsWith('+')) walk(full, true)
				continue
			}
			if (!inFlatFolder) continue
			if (!/\.tsx?$/.test(entry.name)) continue
			if (/\.(test|server|client)\./.test(entry.name)) continue
			if (entry.name.startsWith('__') || entry.name.startsWith('.')) continue
			out.push(path.relative(ROUTES_DIR, full))
		}
	}
	walk(ROUTES_DIR, true)
	return out.sort()
}

const sourceCache = new Map<string, ts.SourceFile | null>()
function parse(file: string): ts.SourceFile | null {
	if (!sourceCache.has(file)) {
		sourceCache.set(
			file,
			fs.existsSync(file)
				? ts.createSourceFile(
						file,
						fs.readFileSync(file, 'utf8'),
						ts.ScriptTarget.Latest,
						true,
					)
				: null,
		)
	}
	return sourceCache.get(file)!
}

function resolveModule(from: string, specifier: string): string | null {
	let base: string
	if (specifier.startsWith('#app/'))
		base = path.join(APP_DIR, specifier.slice(5))
	else if (specifier.startsWith('.'))
		base = path.resolve(path.dirname(from), specifier)
	else return null
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, 'index.ts'),
	]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
			return candidate
	}
	return null
}

type FunctionNode = ts.Node
type Located = { file: string; sf: ts.SourceFile; node: FunctionNode }

/** The declaration of `name` in `file`: a function, a const, or an import. */
function findDeclaration(
	file: string,
	name: string,
	exportedOnly: boolean,
	depth = 0,
): Located | null {
	const sf = parse(file)
	if (!sf || depth > 5) return null
	for (const statement of sf.statements) {
		const exported = Boolean(
			ts.canHaveModifiers(statement) &&
			ts
				.getModifiers(statement)
				?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
		)
		if (exportedOnly && !exported && !ts.isExportDeclaration(statement)) {
			continue
		}
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
			return { file, sf, node: statement }
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === name &&
					declaration.initializer
				) {
					return { file, sf, node: declaration.initializer }
				}
			}
		}
		if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements) {
				if (element.name.text !== name) continue
				const original = (element.propertyName ?? element.name).text
				if (!statement.moduleSpecifier) {
					return findDeclaration(file, original, false, depth + 1)
				}
				const target = resolveModule(
					file,
					(statement.moduleSpecifier as ts.StringLiteral).text,
				)
				return target
					? findDeclaration(target, original, true, depth + 1)
					: null
			}
		}
		if (!exportedOnly && ts.isImportDeclaration(statement)) {
			const bindings = statement.importClause?.namedBindings
			if (!bindings || !ts.isNamedImports(bindings)) continue
			for (const element of bindings.elements) {
				if (element.name.text !== name) continue
				const target = resolveModule(
					file,
					(statement.moduleSpecifier as ts.StringLiteral).text,
				)
				if (!target) return null
				return findDeclaration(
					target,
					(element.propertyName ?? element.name).text,
					true,
					depth + 1,
				)
			}
		}
	}
	return null
}

function calls(node: ts.Node): ts.CallExpression[] {
	const found: ts.CallExpression[] = []
	function visit(child: ts.Node) {
		if (ts.isCallExpression(child)) found.push(child)
		ts.forEachChild(child, visit)
	}
	visit(node)
	return found.sort((a, b) => a.getStart() - b.getStart())
}

const guardCache = new Map<string, Set<GuardKind>>()
/** The guard kinds a call to `name` (as seen from `file`) reaches. */
function guardsReached(file: string, name: string, depth = 0): Set<GuardKind> {
	if (BASE_GUARDS[name]) return new Set(BASE_GUARDS[name])
	const key = `${file}#${name}`
	const cached = guardCache.get(key)
	if (cached) return cached
	const result = new Set<GuardKind>()
	guardCache.set(key, result) // breaks cycles
	if (depth > 4) return result
	const declaration = findDeclaration(file, name, false)
	if (!declaration) return result
	for (const call of calls(declaration.node)) {
		if (!ts.isIdentifier(call.expression)) continue
		for (const kind of guardsReached(
			declaration.file,
			call.expression.text,
			depth + 1,
		)) {
			result.add(kind)
		}
	}
	return result
}

type EntryReport = {
	kinds: Set<GuardKind>
	/** Source of the entry before its first guard call (whole body when none). */
	beforeGuard: string
	firstGuard: string | null
	firstGuardKinds: Set<GuardKind>
}

function analyseEntry(routeFile: string, name: string): EntryReport | null {
	const declaration = findDeclaration(routeFile, name, true)
	if (!declaration) return null
	const kinds = new Set<GuardKind>()
	let firstGuard: ts.CallExpression | null = null
	let firstGuardKinds = new Set<GuardKind>()
	for (const call of calls(declaration.node)) {
		if (!ts.isIdentifier(call.expression)) continue
		const reached = guardsReached(declaration.file, call.expression.text)
		if (reached.size === 0) continue
		if (!firstGuard) {
			firstGuard = call
			firstGuardKinds = reached
		}
		for (const kind of reached) kinds.add(kind)
	}
	const text = declaration.sf.text
	const start = declaration.node.getStart()
	const end = firstGuard ? firstGuard.getStart() : declaration.node.getEnd()
	return {
		kinds,
		beforeGuard: text.slice(start, end),
		firstGuard: firstGuard
			? (firstGuard.expression as ts.Identifier).text
			: null,
		firstGuardKinds,
	}
}

/** Work that must not happen before the caller is identified. */
const UNSAFE_BEFORE_GUARD =
	/\brequest\.(formData|json|text|arrayBuffer|blob)\(|\bparseFormData\(|\b(fetch|tenantFetch)\(|\.(insert|update|delete)\(\s*[A-Z]/
/** Same, for a signature check, which must read the raw body first. */
const UNSAFE_BEFORE_SIGNATURE =
	/\brequest\.(formData|json)\(|\bparseFormData\(|\b(fetch|tenantFetch)\(|\.(insert|update|delete)\(\s*[A-Z]/

function unsafeBeforeGuard(key: string, report: EntryReport) {
	if (key in BODY_BEFORE_GUARD) {
		return /\b(fetch|tenantFetch)\(|\.(insert|update|delete)\(\s*[A-Z]/.test(
			report.beforeGuard,
		)
	}
	const pattern =
		report.firstGuardKinds.has('machine') && report.firstGuardKinds.size === 1
			? UNSAFE_BEFORE_SIGNATURE
			: UNSAFE_BEFORE_GUARD
	return pattern.test(report.beforeGuard)
}

// ---------------------------------------------------------------------------

const files = routeFiles()
const reports = new Map<string, EntryReport>()
for (const file of files) {
	for (const name of ENTRY_NAMES) {
		const report = analyseEntry(path.join(ROUTES_DIR, file), name)
		if (report) reports.set(`${file}#${name}`, report)
	}
}

describe('route guards: discovery', () => {
	it('finds the route modules and their loaders and actions', () => {
		expect(files.length).toBeGreaterThan(250)
		expect(reports.size).toBeGreaterThan(300)
		// Both export forms and re-exports are followed.
		expect(reports.has('_app+/$orgSlug_+/notes.reorder.tsx#action')).toBe(true)
		expect(reports.has('_app+/$orgSlug_+/phone-agent+/flow.tsx#loader')).toBe(
			true,
		)
		expect(reports.has('api+/ai+/chat.tsx#action')).toBe(true)
	})

	it('recognises wrappers through imports', () => {
		expect(
			reports.get('_app+/$orgSlug_+/phone-agent+/details.ts#loader')?.kinds,
		).toContain('membership')
		expect(
			reports.get('_app+/$orgSlug_+/staff+/token.ts#loader')?.kinds,
		).toContain('membership')
	})
})

describe('route guards: every loader and action', () => {
	for (const [key, report] of reports) {
		const file = key.split('#')[0]!
		if (file in PUBLIC_ROUTES || key in PUBLIC_ROUTES || key in GUARD_INJECTED)
			continue
		it(`${key} reaches a guard before reading the request or touching data`, () => {
			expect(report.kinds.size, `${key}: no guard call`).toBeGreaterThan(0)
			expect(
				unsafeBeforeGuard(key, report),
				`${key}: work before ${report.firstGuard}():\n${report.beforeGuard}`,
			).toBe(false)
		})
	}
})

describe('route guards: organization routes check membership', () => {
	for (const [key, report] of reports) {
		if (!key.includes('$orgSlug_+/')) continue
		if (key in MEMBERSHIP_DELEGATED || key in PUBLIC_ROUTES) continue
		it(`${key} checks organization membership`, () => {
			expect([...report.kinds]).toContain('membership')
		})
	}
})

describe('route guards: delegated membership checks', () => {
	it('every note intent handler checks the note’s organization', () => {
		const server = parse(
			path.join(ROUTES_DIR, '_app+/$orgSlug_+/notes.$noteId.server.ts'),
		)!
		const handlers = server.statements.filter(
			(statement): statement is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(statement) &&
				Boolean(statement.name?.text.startsWith('handle')),
		)
		expect(handlers.length).toBeGreaterThan(5)
		const localGuards = ['requireNoteEditAccess', 'requireNoteReadAccess']
		for (const handler of handlers) {
			const names = calls(handler)
				.map((call) => call.expression)
				.filter(ts.isIdentifier)
				.map((identifier) => identifier.text)
			expect(
				names.some(
					(name) =>
						localGuards.includes(name) ||
						BASE_GUARDS[name]?.includes('membership'),
				),
				`${handler.name!.text} has no membership check`,
			).toBe(true)
		}
		// The local helpers themselves check membership.
		const helper = (name: string) =>
			server.statements
				.find(
					(statement) =>
						ts.isFunctionDeclaration(statement) &&
						statement.name?.text === name,
				)!
				.getText()
		expect(helper('requireNoteReadAccess')).toMatch(/await userHasOrgAccess\(/)
		expect(helper('requireNoteEditAccess')).toMatch(
			/await requireNoteReadAccess\(/,
		)
		expect(helper('userHasOrgAccess')).toMatch(
			/await requireUserWithOrganizationPermission\(/,
		)
		const action = findDeclaration(
			path.join(ROUTES_DIR, '_app+/$orgSlug_+/notes.$noteId.tsx'),
			'action',
			true,
		)!
		expect(action.node.getText()).toMatch(/await requireUserId\(/)
	})

	it('the notes view-mode action only sets a cookie', () => {
		const action = findDeclaration(
			path.join(ROUTES_DIR, '_app+/$orgSlug_+/notes.tsx'),
			'action',
			true,
		)!
		const text = action.node.getText()
		expect(text).toMatch(/setNotesViewMode\(/)
		expect(text).not.toMatch(/\bdb\b|fetch\(/)
	})

	const onboardingHandlers = path.resolve(
		APP_DIR,
		'../../../packages/common/src/onboarding/route-handlers',
	)
	it.each(['complete-step.ts', 'hide.ts', 'progress.ts'])(
		'the onboarding handler %s checks the session and organization',
		(file) => {
			const source = fs.readFileSync(
				path.join(onboardingHandlers, file),
				'utf8',
			)
			expect(source).toMatch(/await deps\.requireUserId\(/)
			expect(source).toMatch(/deps\.checkUserOrganizationAccess\(/)
		},
	)
	it.each(Object.keys(GUARD_INJECTED).map((key) => key.split('#')[0]!))(
		'%s passes the real guards to its handler',
		(file) => {
			const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
			expect(source).toMatch(/\brequireUserId,/)
			expect(source).toMatch(/\bcheckUserOrganizationAccess,/)
		},
	)
})

describe('route guards: the public list stays honest', () => {
	for (const [listed, reason] of Object.entries(PUBLIC_ROUTES)) {
		it(`${listed} still exists and still has an unguarded entry (${reason})`, () => {
			const [file, entry] = listed.split('#') as [string, string | undefined]
			expect(files).toContain(file)
			const entries = ENTRY_NAMES.filter((name) => !entry || name === entry)
				.map((name) => reports.get(`${file}#${name}`))
				.filter(Boolean)
			expect(entries.length, 'no loader or action left').toBeGreaterThan(0)
			// A file whose every entry is guarded belongs in the normal sweep.
			expect(
				entries.some(
					(report) =>
						report!.kinds.size === 0 || unsafeBeforeGuard(listed, report!),
				),
				'every entry is guarded now; remove it from PUBLIC_ROUTES',
			).toBe(true)
		})
	}

	for (const key of [
		...Object.keys(MEMBERSHIP_DELEGATED),
		...Object.keys(GUARD_INJECTED),
		...Object.keys(BODY_BEFORE_GUARD),
	]) {
		it(`${key} still exists`, () => {
			expect(reports.has(key)).toBe(true)
		})
	}
})
