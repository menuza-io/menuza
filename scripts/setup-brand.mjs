#!/usr/bin/env node
/**
 * Interactive brand setup script
 * Prompts users to customize their brand assets during initial setup
 */

import { execSync } from 'child_process'
import {
	readFileSync,
	writeFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
} from 'fs'
import { join, dirname, resolve, extname, relative } from 'path'
import { fileURLToPath } from 'url'
import readline from 'readline'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..')

// ANSI color codes for terminal output
const colors = {
	reset: '\x1b[0m',
	bright: '\x1b[1m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[36m',
	gray: '\x1b[90m',
}

function log(message, color = 'reset') {
	console.log(`${colors[color]}${message}${colors.reset}`)
}

function createReadlineInterface() {
	return readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})
}

function question(rl, query) {
	return new Promise((resolve) => {
		rl.question(query, resolve)
	})
}

/**
 * Brand values for an unattended run:
 *
 *   BRAND_NAME="Acme Coffee" BRAND_DOMAIN=acme.co npm run setup:brand
 *
 * `BRAND_SLUG` is derived from the name when omitted; the rest have sensible
 * defaults. Returns null when the required values are missing.
 */
function brandInfoFromEnv() {
	const name = (process.env.BRAND_NAME || '').trim()
	const domain = normalizeAppDomain(process.env.BRAND_DOMAIN, '')
	if (!name || !domain) return null

	const shortName = (process.env.BRAND_SHORT_NAME || '').trim() || name
	const explicitSlug = (process.env.BRAND_SLUG || '').trim()
	// A hand-written slug goes through the same sanitizer as a derived one, so
	// it can always become a Kotlin package segment and a reverse-DNS id.
	const slug = explicitSlug ? toBrandSlug(explicitSlug) : toBrandSlug(shortName)
	return {
		name,
		shortName,
		slug,
		domain,
		tagline:
			(process.env.BRAND_TAGLINE || '').trim() ||
			'Build your next startup even faster',
		description:
			(process.env.BRAND_DESCRIPTION || '').trim() ||
			`${name} is a modern SaaS boilerplate that helps developers and founders launch production-ready applications in minutes.`,
		url: (process.env.BRAND_URL || '').trim() || `https://${domain}`,
		supportEmail:
			(process.env.BRAND_SUPPORT_EMAIL || '').trim() || `support@${domain}`,
		twitterHandle:
			(process.env.BRAND_TWITTER || '').trim() || `@${toBrandId(slug)}`,
		companyName: (process.env.BRAND_COMPANY_NAME || '').trim() || name,
	}
}

async function promptBrandInfo() {
	const rl = createReadlineInterface()

	log('\n🎨 Brand Customization Setup', 'bright')
	log('Customize your brand assets for all apps in the monorepo\n', 'gray')

	const brandName = await question(
		rl,
		`${colors.bright}Brand Name${colors.reset} (default: Epic Startup): `,
	)
	const name = brandName || 'Epic Startup'
	const shortName =
		(await question(
			rl,
			`${colors.bright}Short Name${colors.reset} (Workers, D1, KV, R2 prefix; default: ${name}): `,
		)) || name

	const defaultDomain = `${toBrandSlug(name)}.me`
	const domain = normalizeAppDomain(
		await question(
			rl,
			`${colors.bright}App domain${colors.reset} (e.g. acme.io, acme.dev; local HTTPS, cookies, org subdomains; default: ${defaultDomain}): `,
		),
		defaultDomain,
	)
	const defaultUrl = `https://${domain}`
	const defaultEmail = `support@${domain}`

	const tagline = await question(
		rl,
		`${colors.bright}Tagline${colors.reset} (default: Build your next startup even faster): `,
	)
	const description = await question(
		rl,
		`${colors.bright}Description${colors.reset} (default: A modern SaaS boilerplate...): `,
	)
	const url = await question(
		rl,
		`${colors.bright}Website URL${colors.reset} (default: ${defaultUrl}): `,
	)
	const supportEmail = await question(
		rl,
		`${colors.bright}Support Email${colors.reset} (default: ${defaultEmail}): `,
	)
	const twitterHandle = await question(
		rl,
		`${colors.bright}Twitter Handle${colors.reset} (default: @epicstartup): `,
	)

	rl.close()

	return {
		name,
		shortName,
		slug: toBrandSlug(shortName),
		domain,
		tagline: tagline || 'Build your next startup even faster',
		description:
			description ||
			`${name} is a modern SaaS boilerplate that helps developers and founders launch production-ready applications in minutes.`,
		url: url || defaultUrl,
		supportEmail: supportEmail || defaultEmail,
		twitterHandle: twitterHandle || '@epicstartup',
		companyName: name,
	}
}

async function promptFavicon() {
	const rl = createReadlineInterface()

	log('\n Favicon Setup', 'bright')
	log('You can provide a favicon now or update it later in each app\n', 'gray')

	const faviconPath = await question(
		rl,
		`${colors.bright}Favicon path${colors.reset} (SVG file, or press Enter to skip): `,
	)

	rl.close()

	if (!faviconPath || faviconPath.trim() === '') {
		log('Skipping favicon setup. You can update favicons later in:', 'yellow')
		log('  - apps/app/app/assets/favicons/favicon.svg', 'gray')
		log('  - apps/admin/app/assets/favicons/favicon.svg', 'gray')
		log('  - apps/web/src/assets/favicons/favicon.svg', 'gray')
		log('  - apps/cms/public/favicon.svg', 'gray')
		log('  - apps/docs/favicon.svg', 'gray')
		return null
	}

	const resolvedPath = resolve(process.cwd(), faviconPath.trim())

	if (!existsSync(resolvedPath)) {
		log(`⚠️  File not found: ${resolvedPath}`, 'yellow')
		log(
			'Skipping favicon copy. You can update favicons manually later.',
			'yellow',
		)
		return null
	}

	return resolvedPath
}

/**
 * Escapes a value for a single-quoted TypeScript string *and* for the
 * replacement half of `String.replace`, where `$&`, `$1`, … are patterns and a
 * literal `$` has to be written `$$`.
 */
function escapeString(str) {
	return str
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\$/g, () => '$$')
}

/** A slug that starts with a digit cannot be a Kotlin package or bundle id. */
function withIdentifierStart(slug) {
	return /^[a-z]/.test(slug) ? slug : `app-${slug}`
}

function toBrandSlug(name) {
	const slug = String(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
	let start = 0
	let end = slug.length
	while (start < end && slug.charCodeAt(start) === 45) start += 1
	while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1
	return withIdentifierStart(slug.slice(start, end) || 'app')
}

/** `epic-startup` → `epicstartup`: the brand's compact, identifier-safe id. */
function toBrandId(slug) {
	return withIdentifierStart(String(slug).replace(/-/g, ''))
}

/** `Epic Startup` → `EpicStartup`: used for the Xcode project/product name. */
function toBrandPascal(name) {
	const pascal = String(name)
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join('')
	// A Swift type name cannot start with a digit.
	return /^[A-Za-z]/.test(pascal) ? pascal : `App${pascal}`
}

/** `epic-startup` → `EPIC_STARTUP`: the xcconfig / Info.plist key prefix. */
function toBrandUpper(slug) {
	return String(slug).replace(/-/g, '_').toUpperCase()
}

/** `Epic Startup` → `Epic-Startup`: the brand domain written in title case. */
function toBrandTitleHyphen(name) {
	return String(name)
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join('-')
}

function normalizeAppDomain(value, fallback) {
	const normalized = String(value || '')
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/.*$/, '')
		.replace(/\.$/, '')
		// A hostname cannot hold anything else; keeping the value to this
		// alphabet also keeps it literal in every replacement below.
		.replace(/[^a-z0-9.-]/g, '')
	if (!normalized || !normalized.includes('.')) {
		return fallback
	}
	return normalized
}

const GITHUB_URL_RE = /(https:\/\/(?:api\.)?github\.com\/[^\s)"'`]+)/g
const DEFAULT_BRAND_NAME = 'Epic Startup'
const DEFAULT_BRAND_SLUG = 'epic-startup'
const DEFAULT_BRAND_ID = 'epicstartup'
const DEFAULT_BRAND_DOMAIN = 'epic-startup.com'
const PROTECTED_SLUG_RE =
	/packageJson\[['"']epic-startup['"']\]|epic-startup field/g

// Dot entries that are tool caches or VCS internals. Everything else — including
// `.agents`, `.husky`, `.gitleaks.toml` and `.env*` — is repo content and is
// rewritten like any other file.
const SKIP_DOT_ENTRIES = new Set([
	'.amp',
	'.cache',
	'.idea',
	'.next',
	'.output',
	'.turbo',
	'.vercel',
	'.vscode',
	'.DS_Store',
])

const SKIP_DIR_NAMES = new Set([
	'Generated',
	'node_modules',
	'.git',
	'dist',
	'coverage',
	'.turbo',
	'.next',
	'.open-next',
	'build',
	'.cache',
	'playwright-report',
	'test-results',
	'.output',
	'.vercel',
	'fixtures',
])

const SKIP_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.svg',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.db',
	'.sqlite',
	'.mp4',
	'.webm',
	'.map',
	'.bin',
	'.wasm',
	'.pdf',
	'.zip',
	'.lock',
])

/**
 * Names that merely contain "epic" but belong to other people: the `@epic-web`
 * npm scope (this repo's tooling) and the EpicWeb/EpicReact learning sites that
 * `docs/community.md` points at. A rebrand must not touch them.
 */
const THIRD_PARTY_EPIC_RE = /@?epic-web|epicweb|epicreact|EpicWeb|EpicReact/g

/**
 * Rewrites the template's brand in every shape it takes, so a fork carries none
 * of it: the name (`Epic Startup`), the upstream template name (`Epic Stack`),
 * the slug (`epic-startup`), the compact id (`epicstartup`), the snake and
 * title-hyphen forms (`epic_startup`, `Epic-Startup`), the env/key prefixes
 * (`EPIC_`, `epic_`, `epic-`), the domains, and the PascalCase identifiers built
 * from the bare brand (`EpicToaster`, `EpicProgress`). The native apps' dotted
 * `epic.` preference names are handled by `nativeAppTokenPairs`.
 *
 * The rules are applied in a single pass, longest token first. A replacement is
 * written straight to the output, so brand text that itself contains a template
 * token (a brand named "Epic Coffee") or a `$` cannot be rewritten again — or
 * read as a `$&`/`$1` pattern — by a later rule.
 */
function replaceBrandTokens(content, { name, slug, domain }) {
	const brandId = toBrandId(slug)
	const snakeSlug = slug.replace(/-/g, '_')
	const upperSlug = snakeSlug.toUpperCase()
	const pascalName = toBrandPascal(name)
	const titleHyphenName = toBrandTitleHyphen(name)
	const snakeDefault = DEFAULT_BRAND_SLUG.replace(/-/g, '_')
	const upperDefault = snakeDefault.toUpperCase()

	if (
		name === DEFAULT_BRAND_NAME &&
		slug === DEFAULT_BRAND_SLUG &&
		domain === DEFAULT_BRAND_DOMAIN
	) {
		return content
	}

	// GitHub links (other people's repos, this template's own history) and the
	// third-party names above are never rewritten.
	const protectedSlices = []
	const protect = (match) => {
		protectedSlices.push(match)
		return `__BRAND_PROTECT_${protectedSlices.length - 1}__`
	}
	const withPlaceholders = content
		.replace(PROTECTED_SLUG_RE, protect)
		.replace(THIRD_PARTY_EPIC_RE, protect)
		// The fork's own brand is protected too, so running the setup again (or
		// using a brand whose name contains a template word) leaves it alone.
		.replace(
			new RegExp(
				brandIdentifierShapes({ name, slug, domain })
					.sort((a, b) => b.length - a.length)
					.map(escapeRegExp)
					.join('|'),
				'g',
			),
			protect,
		)

	// Longest / most specific forms first: `epic-startup.com` was handled above,
	// then the names, the slug, the upstream template name, and the snake,
	// title-hyphen, PascalCase and bare-`Epic` shapes. A rule whose value equals
	// its token is kept on purpose: it stops a shorter rule from matching the
	// same text (`Epic Startup` must not become `Epic Startup Startup`).
	const rules = [
		[escapeRegExp(`${DEFAULT_BRAND_SLUG}.com`), domain],
		[escapeRegExp(`${DEFAULT_BRAND_ID}.com`), domain],
		[escapeRegExp('epicstack.dev'), domain],
		[escapeRegExp(DEFAULT_BRAND_NAME), name],
		[String.raw`Epic\s+Stack`, name],
		[escapeRegExp('Epic+Stack'), name.replace(/ /g, '+')],
		[escapeRegExp(DEFAULT_BRAND_SLUG), slug],
		[escapeRegExp('epic-stack'), slug],
		[escapeRegExp('epicnotes'), slug],
		[escapeRegExp('epicstack'), brandId],
		[escapeRegExp(upperDefault), upperSlug],
		[escapeRegExp(snakeDefault), snakeSlug],
		[escapeRegExp('Epic-Startup'), titleHyphenName],
		[escapeRegExp('EpicStartup'), pascalName],
		[escapeRegExp('EPIC_'), `${upperSlug}_`],
		[escapeRegExp('epic_'), `${snakeSlug}_`],
		[escapeRegExp('Epic-'), `${titleHyphenName}-`],
		[escapeRegExp('epic-'), `${slug}-`],
		// Bare `Epic` used as an identifier prefix: EpicToaster, …
		[String.raw`Epic(?=[A-Z])`, pascalName],
		// …and standalone (`^^Epic^^`, `fromName: 'Epic Support'`).
		[String.raw`\bEpic\b`, name],
		[escapeRegExp(DEFAULT_BRAND_ID), brandId],
	]

	const replaced = withPlaceholders
		.split(GITHUB_URL_RE)
		.map((part, index) =>
			index % 2 === 1 ? part : replaceBrandRules(part, rules),
		)
		.join('')

	return replaced.replace(
		/__BRAND_PROTECT_(\d+)__/g,
		(_, index) => protectedSlices[Number(index)] ?? _,
	)
}

/** Regex-escapes a literal token so it can join the replacement alternation. */
function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every shape the *new* brand takes. They are protected before the template
 * tokens are rewritten, so a second run — or a brand that itself contains a
 * template word, like "Epic Coffee" — cannot rewrite the fork's own brand.
 */
function brandIdentifierShapes({ name, slug, domain }) {
	const snakeSlug = slug.replace(/-/g, '_')
	return [
		name,
		// URL-encoded in OAuth app names, the way `Epic+Stack` is.
		name.replace(/ /g, '+'),
		domain,
		slug,
		toBrandId(slug),
		toBrandPascal(name),
		toBrandTitleHyphen(name),
		snakeSlug,
		snakeSlug.toUpperCase(),
	].filter(Boolean)
}

/**
 * Applies every rule in one pass, longest token first. The replacement is a
 * function, so a `$` in the brand text stays literal.
 */
function replaceBrandRules(text, rules) {
	if (!text) return text
	const pattern = new RegExp(
		rules.map(([source], index) => `(?<rule${index}>${source})`).join('|'),
		'g',
	)
	return text.replace(pattern, (match, ...rest) => {
		const groups = rest.at(-1)
		if (!groups || typeof groups !== 'object') return match
		const matched = Object.keys(groups).find((key) => groups[key] !== undefined)
		return matched === undefined ? match : rules[Number(matched.slice(4))][1]
	})
}

function shouldSkipBrandRewrite(relPath) {
	const parts = relPath.split(/[\\/]/)
	if (parts.some((part) => SKIP_DIR_NAMES.has(part))) return true
	const base = parts.at(-1) ?? ''
	if (base === 'setup-brand.mjs' || base === 'ts-log.txt') return true
	// Per-tenant build artifacts: regenerated by the tenant generators.
	if (base === 'tenant.properties' || base === 'keystore.properties')
		return true
	if (SKIP_EXTENSIONS.has(extname(base).toLowerCase())) return true
	return false
}

function listRewritableFiles(dir, acc = []) {
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return acc
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name)
		const relPath = relative(rootDir, fullPath)

		if (entry.isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue
			if (SKIP_DOT_ENTRIES.has(entry.name)) continue
			listRewritableFiles(fullPath, acc)
			continue
		}

		if (shouldSkipBrandRewrite(relPath)) continue
		if (SKIP_DOT_ENTRIES.has(entry.name)) continue

		acc.push(relPath)
	}

	return acc
}

function updateFileWithBrandTokens(relPath, brandInfo) {
	const filePath = join(rootDir, relPath)
	if (!existsSync(filePath)) return false

	let original
	try {
		original = readFileSync(filePath, 'utf-8')
	} catch {
		return false
	}
	if (original.includes('\u0000')) return false

	const updated = replaceBrandTokens(original, brandInfo)
	if (updated === original) return false

	writeFileSync(filePath, updated, 'utf-8')
	return true
}

function updateBrandConfig(brandInfo) {
	const brandPath = join(rootDir, 'packages/config/brand.ts')
	let content = readFileSync(brandPath, 'utf-8')

	const escapedName = escapeString(brandInfo.name)
	const escapedShortName = escapeString(brandInfo.shortName)
	const escapedSlug = escapeString(brandInfo.slug)
	const escapedDomain = escapeString(brandInfo.domain)
	const escapedTagline = escapeString(brandInfo.tagline)
	const escapedDescription = escapeString(brandInfo.description)
	const escapedCompanyName = escapeString(brandInfo.companyName)

	// Replace core brand identity (exact matches)
	content = content.replace(
		/\tname: 'Epic Startup',/g,
		`\tname: '${escapedName}',`,
	)
	content = content.replace(
		/\tshortName: 'Epic Startup',/g,
		`\tshortName: '${escapedShortName}',`,
	)
	content = content.replace(
		/\tslug: 'epic-startup',/g,
		`\tslug: '${escapedSlug}',`,
	)
	content = content.replace(
		/\tdomain: 'epic-startup.com',/g,
		`\tdomain: '${escapedDomain}',`,
	)
	content = content.replace(
		/\ttagline: 'Build your next startup even faster',/g,
		`\ttagline: '${escapedTagline}',`,
	)

	// Replace description (multiline)
	const descriptionPattern =
		/description:\s*\n\s*'Epic Startup is a modern SaaS boilerplate[^']*',/g
	content = content.replace(
		descriptionPattern,
		`description:\n\t\t'${escapedDescription}',`,
	)

	// Replace URLs and contact
	content = content.replace(
		/\turl: 'https:\/\/epicstartup\.com',/g,
		`\turl: '${brandInfo.url}',`,
	)
	content = content.replace(
		/\tsupportEmail: 'support@epicstartup\.com',/g,
		`\tsupportEmail: '${brandInfo.supportEmail}',`,
	)
	content = content.replace(
		/\ttwitterHandle: '@epicstartup',/g,
		`\ttwitterHandle: '${brandInfo.twitterHandle}',`,
	)

	// Replace company name
	content = content.replace(
		/\tcompanyName: 'Epic Startup',/g,
		`\tcompanyName: '${escapedCompanyName}',`,
	)

	// Replace product names in products object
	content = content.replace(
		/\t\tname: 'Epic Startup',/g,
		`\t\tname: '${escapedName}',`,
	)
	content = content.replace(
		/\t\tname: 'Epic Startup Admin',/g,
		`\t\tname: '${escapedName} Admin',`,
	)
	content = content.replace(
		/\t\tname: 'Epic Startup Extension',/g,
		`\t\tname: '${escapedName} Extension',`,
	)
	content = content.replace(
		/\t\tname: 'Epic Startup CMS',/g,
		`\t\tname: '${escapedName} CMS',`,
	)
	content = content.replace(
		/\t\tname: 'Epic Startup Sites',/g,
		`\t\tname: '${escapedName} Sites',`,
	)
	content = content.replace(
		/\t\tchrome: 'Epic Startup Chrome Extension',/g,
		`\t\tchrome: '${escapedName} Chrome Extension',`,
	)
	content = content.replace(
		/\t\tfirefox: 'Epic Startup Firefox Extension',/g,
		`\t\tfirefox: '${escapedName} Firefox Extension',`,
	)

	// Replace product descriptions that reference brand name
	content = content.replace(
		/\t\tdescription: 'Admin dashboard for Epic Startup',/g,
		`\t\tdescription: 'Admin dashboard for ${escapedName}',`,
	)
	content = content.replace(
		/\t\tdescription: 'Chrome extension for Epic Startup',/g,
		`\t\tdescription: 'Chrome extension for ${escapedName}',`,
	)
	content = content.replace(
		/\t\tdescription: 'Content management system for Epic Startup',/g,
		`\t\tdescription: 'Content management system for ${escapedName}',`,
	)

	// Replace email subjects
	content = content.replace(
		/\t\tpasswordReset: 'Epic Startup Password Reset',/g,
		`\t\tpasswordReset: '${escapedName} Password Reset',`,
	)
	content = content.replace(
		/\t\twelcome: 'Welcome to Epic Startup!',/g,
		`\t\twelcome: 'Welcome to ${escapedName}!',`,
	)
	content = content.replace(
		/\t\temailChange: 'Epic Startup Email Change Verification',/g,
		`\t\temailChange: '${escapedName} Email Change Verification',`,
	)
	content = content.replace(
		/\t\tnewDeviceSignin: 'New Sign-In Detected - Epic Startup',/g,
		`\t\tnewDeviceSignin: 'New Sign-In Detected - ${escapedName}',`,
	)

	// Replace AI system prompt
	content = content.replace(
		/You are an intelligent AI assistant for Epic Startup,/g,
		`You are an intelligent AI assistant for ${brandInfo.name},`,
	)

	writeFileSync(brandPath, content, 'utf-8')
	log(`✅ Updated ${brandPath}`, 'green')
}

function updateEnvFiles(brandInfo) {
	const domain = brandInfo.domain
	const localDomain = `${brandInfo.slug}.test`
	const envFiles = [
		'apps/app/.env',
		'apps/admin/.env',
		'apps/sites/.env',
		'apps/tenant-api/.env',
		'apps/web/.env',
		'apps/app/.env.example',
		'apps/admin/.env.example',
		'apps/sites/.env.example',
		'apps/tenant-api/.env.example',
		'apps/web/.env.example',
		'apps/app/.env.schema',
		'apps/admin/.env.schema',
		'apps/sites/.env.schema',
		'apps/tenant-api/.env.schema',
		'apps/web/.env.schema',
	]

	let updatedCount = 0

	for (const envFile of envFiles) {
		const envPath = join(rootDir, envFile)

		try {
			if (!existsSync(envPath)) {
				continue
			}

			let content = readFileSync(envPath, 'utf-8')
			const original = content

			content = content.replace(/^ROOT_APP=.*$/m, `ROOT_APP=${localDomain}`)
			content = content.replace(
				/^PUBLIC_ROOT_APP=.*$/m,
				`PUBLIC_ROOT_APP=${localDomain}`,
			)
			content = content.replace(
				/CLOUDFLARE_CUSTOM_HOSTNAME_CNAME_TARGET=sites\.epic-startup\.com/g,
				`CLOUDFLARE_CUSTOM_HOSTNAME_CNAME_TARGET=sites.${domain}`,
			)
			if (envFile.startsWith('apps/app/')) {
				content = content.replace(
					/^BASE_URL=.*$/m,
					`BASE_URL="https://app.${localDomain}:2999"`,
				)
			}
			if (envFile.startsWith('apps/admin/')) {
				content = content.replace(
					/^BASE_URL=.*$/m,
					`BASE_URL="https://admin.${localDomain}:2999"`,
				)
			}
			if (envFile.startsWith('apps/sites/')) {
				content = content.replace(
					/^PUBLIC_APP_URL=.*$/m,
					`PUBLIC_APP_URL=https://app.${localDomain}:2999`,
				)
			}

			if (content !== original) {
				writeFileSync(envPath, content, 'utf-8')
				updatedCount++
				log(
					`✅ Updated ${envFile} (local: ${localDomain}, production: ${domain})`,
					'green',
				)
			}
		} catch (error) {
			log(`⚠️  Failed to update ${envFile}: ${error.message}`, 'yellow')
		}
	}

	if (updatedCount > 0) {
		log(
			`\n✅ Successfully updated domain references in ${updatedCount} environment/schema files`,
			'green',
		)
	}
}

function fileHasUnprotectedBrandTokens(content, brandInfo) {
	const withoutGithub = content
		.split(GITHUB_URL_RE)
		.filter((_, index) => index % 2 === 0)
		.join('')
		.replace(PROTECTED_SLUG_RE, '')
	return (
		(brandInfo.name !== DEFAULT_BRAND_NAME &&
			withoutGithub.includes(DEFAULT_BRAND_NAME)) ||
		(brandInfo.slug !== DEFAULT_BRAND_SLUG &&
			withoutGithub.includes(DEFAULT_BRAND_SLUG)) ||
		(brandInfo.domain !== DEFAULT_BRAND_DOMAIN &&
			withoutGithub.includes(DEFAULT_BRAND_DOMAIN))
	)
}

function updateStaticBrandFiles(brandInfo) {
	log('\n📦 Updating product names and slugs across the repo', 'bright')
	const files = listRewritableFiles(rootDir)
	const updated = []
	for (const file of files) {
		if (updateFileWithBrandTokens(file, brandInfo)) updated.push(file)
	}
	log(`✅ Rewrote brand tokens in ${updated.length} files`, 'green')
	for (const file of updated.slice(0, 40)) {
		log(`   - ${file}`, 'gray')
	}
	if (updated.length > 40) {
		log(`   - …and ${updated.length - 40} more`, 'gray')
	}

	const leftovers = files.filter((relPath) => {
		if (relPath.endsWith('setup-brand.mjs')) return false
		try {
			return fileHasUnprotectedBrandTokens(
				readFileSync(join(rootDir, relPath), 'utf-8'),
				brandInfo,
			)
		} catch {
			return false
		}
	})

	if (leftovers.length > 0) {
		log(
			`\n⚠️  ${leftovers.length} files still mention the old brand (GitHub template links are kept):`,
			'yellow',
		)
		for (const file of leftovers.slice(0, 20)) {
			log(`   - ${file}`, 'gray')
		}
		if (leftovers.length > 20) {
			log(`   - …and ${leftovers.length - 20} more`, 'gray')
		}
	} else {
		log(
			'✅ No leftover product brand strings outside GitHub template links',
			'green',
		)
	}
}

// ---------------------------------------------------------------- native apps --
// The mobile apps carry brand identifiers the generic token pass cannot derive:
// a reverse-DNS bundle/package id (`com.epicstartup.tenant`), the Xcode
// project/product name (`EpicTenantApp`), the xcconfig + Info.plist key
// prefixes (`EPIC_*`, `Epic*`), and the preference/Keystore names (`epic.*`).
// Renaming them — including the Kotlin package directory — is what leaves a
// fresh clone that ran `npm run setup` with no trace of the template's brand.

const NATIVE_APP_DIRS = ['apps/ios', 'apps/android']
const NATIVE_APP_EXTRA_FILES = [
	'.github/workflows/ios.yml',
	'.github/workflows/android.yml',
]
// Non-global on purpose: `test()` on a global regex is stateful.
const NATIVE_APP_TOKEN_RE =
	/epicstartup|EPIC_|EpicTenantApp|Epic-Startup|\bEpic(?=[A-Z])|\bepic\./

function nativeAppTokenPairs(brandInfo) {
	// The other native identifier shapes (bundle ids, `EPIC_*`, `Epic*`,
	// `EpicTenantApp`) are covered by the global pass; only the dotted
	// preference/Keystore names are native-specific.
	return [{ pattern: /\bepic\./g, replacement: () => `${brandInfo.slug}.` }]
}

function nativeAppDisplayNamePairs(brandInfo) {
	// Functions, not templates: a brand name may contain `$`.
	return [
		{
			pattern: /^(EPIC_APP_DISPLAY_NAME = )Tenant$/m,
			replacement: (_match, prefix) => `${prefix}${brandInfo.name}`,
		},
		{
			pattern: /tenantValue\("appName", "Tenant"\)/,
			replacement: () =>
				`tenantValue("appName", ${kotlinString(brandInfo.name)})`,
		},
	]
}

/**
 * A Kotlin string literal for `value`: `JSON.stringify` covers quotes,
 * backslashes and control characters, and `$` is escaped because it would
 * otherwise start a template expression in the generated `build.gradle.kts`.
 */
function kotlinString(value) {
	return JSON.stringify(String(value)).replace(/\$/g, () => '\\$')
}

function listNativeAppFiles() {
	const files = []
	for (const dir of NATIVE_APP_DIRS) {
		listRewritableFiles(join(rootDir, dir), files)
	}
	for (const file of NATIVE_APP_EXTRA_FILES) {
		if (existsSync(join(rootDir, file))) files.push(file)
	}
	return files
}

/** Renames the Kotlin package directories and the Swift app entry point. */
function renameNativeAppPaths(brandInfo) {
	const brandId = toBrandId(brandInfo.slug)
	const brandPascal = toBrandPascal(brandInfo.name)
	const moves = [
		[
			'apps/android/app/src/main/kotlin/com/epicstartup',
			`apps/android/app/src/main/kotlin/com/${brandId}`,
		],
		[
			'apps/android/app/src/test/kotlin/com/epicstartup',
			`apps/android/app/src/test/kotlin/com/${brandId}`,
		],
		[
			'apps/ios/Sources/TenantApp/EpicTenantApp.swift',
			`apps/ios/Sources/TenantApp/${brandPascal}TenantApp.swift`,
		],
	]

	const moved = []
	for (const [fromRel, toRel] of moves) {
		const from = join(rootDir, fromRel)
		const to = join(rootDir, toRel)
		if (!existsSync(from) || existsSync(to)) continue
		mkdirSync(dirname(to), { recursive: true })
		renameSync(from, to)
		moved.push(toRel)
	}
	return moved
}

function updateNativeAppConfigs(brandInfo) {
	log('\n📱 Renaming the native app identity (iOS + Android)', 'bright')

	if (
		brandInfo.name === DEFAULT_BRAND_NAME &&
		brandInfo.slug === DEFAULT_BRAND_SLUG
	) {
		log('Brand unchanged — nothing to rename.', 'gray')
		return
	}

	const pairs = [
		...nativeAppDisplayNamePairs(brandInfo),
		...nativeAppTokenPairs(brandInfo),
	]
	const updated = []

	for (const relPath of listNativeAppFiles()) {
		const filePath = join(rootDir, relPath)
		let content
		try {
			content = readFileSync(filePath, 'utf-8')
		} catch {
			continue
		}
		if (content.includes('\u0000')) continue

		let next = content
		for (const { pattern, replacement } of pairs) {
			next = next.replace(pattern, replacement)
		}
		if (next === content) continue
		writeFileSync(filePath, next, 'utf-8')
		updated.push(relPath)
	}

	const moved = renameNativeAppPaths(brandInfo)

	log(`✅ Renamed brand identifiers in ${updated.length} files`, 'green')
	for (const file of updated.slice(0, 12)) log(`   - ${file}`, 'gray')
	if (updated.length > 12) {
		log(`   - …and ${updated.length - 12} more`, 'gray')
	}
	for (const path of moved) log(`   ↳ moved ${path}`, 'gray')

	const leftovers = listNativeAppFiles().filter((relPath) => {
		try {
			return NATIVE_APP_TOKEN_RE.test(
				readFileSync(join(rootDir, relPath), 'utf-8'),
			)
		} catch {
			return false
		}
	})

	if (leftovers.length > 0) {
		log(
			`\n⚠️  ${leftovers.length} native app files still mention the template brand:`,
			'yellow',
		)
		for (const file of leftovers.slice(0, 20)) log(`   - ${file}`, 'gray')
	} else {
		log('✅ No template brand left in the native apps', 'green')
	}

	log(
		'💡 Per-tenant configs are generated: npm run ios:tenant -w ios / npm run android:tenant -w android',
		'blue',
	)
}

function updateMobileDeepLinkScheme(brandInfo) {
	// `expo.scheme` is the brand slug; the navigation helpers hardcode the
	// template's scheme (`epicnotes://`), so they have to follow it — but only
	// when the brand actually changed.
	if (brandInfo.slug === DEFAULT_BRAND_SLUG) return

	let updated = 0
	for (const relPath of listRewritableFiles(join(rootDir, 'apps/mobile'))) {
		const filePath = join(rootDir, relPath)
		let content
		try {
			content = readFileSync(filePath, 'utf-8')
		} catch {
			continue
		}
		if (!content.includes('epicnotes')) continue
		writeFileSync(
			filePath,
			content.replaceAll('epicnotes', brandInfo.slug),
			'utf-8',
		)
		updated++
	}
	if (updated > 0) {
		log(`✅ Updated the mobile deep-link scheme in ${updated} files`, 'green')
	}
}

/**
 * Brand-shaped tokens only: the English word "epic" ("an epic day on the
 * slopes") is not a brand reference and must not be reported.
 */
const REMAINING_BRAND_RE =
	/\bepic(?:startup|stack|notes)|\bEPIC_[A-Z0-9_]*|\bepic[._-][\w.-]*|\bEpic\b|\bEpic(?=[A-Z])|\bEpic\s+Stack\b|\bEpic\+Stack\b/g

/**
 * Last line of defence: a fork should carry none of the template's brand. This
 * scans every rewritable file for "epic" and reports what is left, so a missed
 * spot is visible immediately instead of months later.
 */
function reportRemainingBrandTokens(brandInfo) {
	log('\n🔎 Checking for leftover template brand references', 'bright')

	if (
		brandInfo.name === DEFAULT_BRAND_NAME &&
		brandInfo.slug === DEFAULT_BRAND_SLUG &&
		brandInfo.domain === DEFAULT_BRAND_DOMAIN
	) {
		log('Brand unchanged — nothing to check.', 'gray')
		return
	}

	const remaining = []
	for (const relPath of listRewritableFiles(rootDir)) {
		let content
		try {
			content = readFileSync(join(rootDir, relPath), 'utf-8')
		} catch {
			continue
		}
		const withoutProtected = content
			.split(GITHUB_URL_RE)
			.filter((_, index) => index % 2 === 0)
			.join('')
			.replace(PROTECTED_SLUG_RE, '')
			.replace(THIRD_PARTY_EPIC_RE, '')
		// The new brand may itself contain a template-shaped word (a fork named
		// "Epic Coffee", whose header becomes `X-Epic-Coffee-Org-Id`): those are
		// the fork's own brand, not a leftover.
		const brandTokens = brandIdentifierShapes(brandInfo).sort(
			(a, b) => b.length - a.length,
		)
		const withoutBrand = brandTokens.reduce(
			(text, token) => text.split(token).join(''),
			withoutProtected,
		)
		const matches = withoutBrand.match(REMAINING_BRAND_RE)
		if (matches && matches.length > 0) {
			remaining.push({
				relPath,
				tokens: [...new Set(matches.map((token) => token.toLowerCase()))],
			})
		}
	}

	if (remaining.length === 0) {
		log('✅ No template brand references left', 'green')
		log(
			'   (third-party names such as @epic-web, EpicWeb.dev and EpicReact.dev are kept)',
			'gray',
		)
		return
	}

	log(`⚠️  ${remaining.length} files still mention "epic":`, 'yellow')
	for (const { relPath, tokens } of remaining.slice(0, 30)) {
		log(`   - ${relPath}  (${tokens.join(', ')})`, 'gray')
	}
	if (remaining.length > 30) {
		log(`   - …and ${remaining.length - 30} more`, 'gray')
	}
	log(
		'   Third-party names (@epic-web, EpicWeb.dev, EpicReact.dev) are expected to remain.',
		'gray',
	)
}

function rebuildBrandPackage() {
	try {
		execSync('npm run build --workspace=@repo/config', {
			cwd: rootDir,
			stdio: 'inherit',
		})
		log('✅ Rebuilt @repo/config so apps pick up the new brand', 'green')
	} catch (error) {
		log(
			`⚠️  Failed to rebuild @repo/config: ${error.message}. Run npm run build --workspace=@repo/config`,
			'yellow',
		)
	}
}

function updateMobileAppConfig(brandInfo) {
	const appJsonPath = join(rootDir, 'apps/mobile/app.json')

	try {
		if (!existsSync(appJsonPath)) {
			log(`⚠️  Mobile app.json not found: ${appJsonPath}`, 'yellow')
			return
		}

		const content = readFileSync(appJsonPath, 'utf-8')
		const appConfig = JSON.parse(content)

		const mobileAppName = `${brandInfo.name} Mobile`
		const slug = `${brandInfo.slug}-mobile`
		const domain = brandInfo.domain
		const bundleId = `com.${brandInfo.slug.replace(/-/g, '')}.mobile`

		appConfig.expo.name = mobileAppName
		appConfig.expo.slug = slug
		appConfig.expo.scheme = brandInfo.slug
		appConfig.expo.ios.bundleIdentifier = bundleId
		appConfig.expo.android.package = bundleId
		appConfig.expo.linking.prefixes = [
			`${brandInfo.slug}://`,
			`https://${domain}`,
		]

		// Compare before writing: serializing reformats the file, and an
		// unchanged brand must not dirty the tree.
		const current = JSON.parse(content)
		const unchanged =
			current.expo?.name === mobileAppName &&
			current.expo?.slug === slug &&
			current.expo?.scheme === brandInfo.slug &&
			current.expo?.ios?.bundleIdentifier === bundleId &&
			current.expo?.android?.package === bundleId &&
			JSON.stringify(current.expo?.linking?.prefixes) ===
				JSON.stringify(appConfig.expo.linking.prefixes)
		if (unchanged) {
			log('✅ Mobile app configuration already matches the brand', 'green')
			return
		}

		// Write back the updated configuration
		writeFileSync(appJsonPath, JSON.stringify(appConfig, null, '\t'), 'utf-8')
		log(`✅ Updated mobile app configuration in apps/mobile/app.json`, 'green')
		log(`   - App name: ${mobileAppName}`, 'gray')
		log(`   - Slug: ${slug}`, 'gray')
		log(`   - Bundle ID: ${bundleId}`, 'gray')
		log(`   - Domain: ${domain}`, 'gray')
	} catch (error) {
		log(`⚠️  Failed to update mobile app.json: ${error.message}`, 'yellow')
	}
}

function copyFavicon(faviconPath) {
	if (!faviconPath) return

	const faviconDestinations = [
		'apps/app/app/assets/favicons/favicon.svg',
		'apps/admin/app/assets/favicons/favicon.svg',
		'apps/web/src/assets/favicons/favicon.svg',
		'apps/web/public/favicons/favicon.svg',
		'apps/cms/public/favicon.svg',
		'apps/docs/favicon.svg',
		'apps/docs/logo/light.svg',
		'apps/docs/logo/dark.svg',
	]

	let copiedCount = 0

	for (const dest of faviconDestinations) {
		const destPath = join(rootDir, dest)
		const destDir = dirname(destPath)

		try {
			if (!existsSync(destDir)) {
				mkdirSync(destDir, { recursive: true })
			}
			copyFileSync(faviconPath, destPath)
			copiedCount++
			log(`✅ Copied favicon to ${dest}`, 'green')
		} catch (error) {
			log(`⚠️  Failed to copy to ${dest}: ${error.message}`, 'yellow')
		}
	}

	if (copiedCount > 0) {
		log(`\n✅ Successfully copied favicon to ${copiedCount} locations`, 'green')
		log(
			'💡 Note: You may want to generate PNG versions (192x192, 512x512) for web manifests',
			'blue',
		)
	}
}

/**
 * The native apps embed these values as identifiers — a Kotlin package
 * (`com.<brandId>.tenant`), a reverse-DNS bundle id, a Swift type name — so a
 * brand that cannot produce valid ones is rejected before any file is written.
 */
function assertBrandIdentifiers({ name, slug }) {
	const brandId = toBrandId(slug)
	const pascalName = toBrandPascal(name)
	if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug)) {
		throw new Error(
			`The brand slug "${slug}" must be lowercase letters, digits and dashes.`,
		)
	}
	if (!/^[a-z][a-z0-9]*$/.test(brandId)) {
		throw new Error(
			`The brand slug "${slug}" cannot form a package id ("${brandId}").`,
		)
	}
	if (!/^[A-Za-z][A-Za-z0-9]*$/.test(pascalName)) {
		throw new Error(
			`The brand name "${name}" cannot form a Swift type name ("${pascalName}").`,
		)
	}
}

async function main() {
	try {
		// Check if SKIP_BRAND_SETUP is set
		if (process.env.SKIP_BRAND_SETUP === 'true') {
			log('Skipping brand setup (SKIP_BRAND_SETUP=true)', 'gray')
			return
		}

		// Unattended runs (CI, scripted setups) take the brand from the
		// environment; otherwise fall back to the interactive prompts.
		const envBrand = brandInfoFromEnv()
		if (!envBrand && !process.stdin.isTTY) {
			log('Running in non-interactive mode. Skipping brand setup.', 'gray')
			log(
				'Run "npm run setup:brand" later to customize your brand, or set',
				'gray',
			)
			log('BRAND_NAME and BRAND_DOMAIN to run it unattended.', 'gray')
			return
		}

		const brandInfo = envBrand ?? (await promptBrandInfo())
		assertBrandIdentifiers(brandInfo)
		updateBrandConfig(brandInfo)
		updateEnvFiles(brandInfo)
		updateMobileAppConfig(brandInfo)
		updateMobileDeepLinkScheme(brandInfo)
		updateStaticBrandFiles(brandInfo)
		updateNativeAppConfigs(brandInfo)
		reportRemainingBrandTokens(brandInfo)
		rebuildBrandPackage()

		const faviconPath = envBrand ? null : await promptFavicon()
		if (faviconPath) {
			copyFavicon(faviconPath)
		}

		log('\n✨ Brand setup complete!', 'green')
		log('Your brand configuration has been updated across all apps.', 'gray')
		log(
			'You can further customize brand settings in packages/config/brand.ts\n',
			'gray',
		)
	} catch (error) {
		// Handle Ctrl+C gracefully
		if (error.code === 'SIGINT' || error.message?.includes('SIGINT')) {
			log('\n\n⚠️  Setup cancelled by user', 'yellow')
			process.exit(0)
		}
		log(`\n❌ Error during brand setup: ${error.message}`, 'red')
		if (error.stack) {
			log(error.stack, 'gray')
		}
		process.exit(1)
	}
}

const isDirectRun =
	Boolean(process.argv[1]) && resolve(process.argv[1]) === __filename

if (isDirectRun) {
	main()
}

export {
	listNativeAppFiles,
	replaceBrandTokens,
	toBrandId,
	toBrandPascal,
	toBrandTitleHyphen,
	toBrandUpper,
	updateNativeAppConfigs,
}
