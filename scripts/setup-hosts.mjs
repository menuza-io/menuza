#!/usr/bin/env node
/**
 * Hosts file setup script
 * Adds local development domains to /etc/hosts based on brand configuration
 * and active organization slugs from the database (for Sites subdomains).
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync, execSync } from 'child_process'
import { createClient } from '@libsql/client'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..')

// Must stay in sync with reserved labels in dev-proxy.js and apps/sites middleware
const RESERVED_SUBDOMAINS = new Set([
	'app',
	'admin',
	'docs',
	'studio',
	'api',
	'api-ksa',
	'www',
	'mail',
	'ftp',
	'sites',
	'status',
	'cdn',
	'static',
	'assets',
])

const PRODUCT_SUBDOMAINS = [
	'',
	'app.',
	'admin.',
	'studio.',
	'docs.',
	'api.',
	'api-ksa.',
]

// ANSI color codes for terminal output
const colors = {
	reset: '\x1b[0m',
	bright: '\x1b[1m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[36m',
	red: '\x1b[31m',
	gray: '\x1b[90m',
}

function log(message, color = 'reset') {
	console.log(`${colors[color]}${message}${colors.reset}`)
}

function getBrandDomain() {
	try {
		const brandConfigPath = join(rootDir, 'packages/config/brand.ts')
		if (!existsSync(brandConfigPath)) {
			log('⚠️  Brand config not found, using default domain', 'yellow')
			return 'menuza.io'
		}

		const brandContent = readFileSync(brandConfigPath, 'utf-8')
		const domainMatch = brandContent.match(/^\tdomain:\s*'([^']+)'/m)
		if (domainMatch?.[1]) {
			return domainMatch[1]
		}

		const slugMatch = brandContent.match(/^\tslug:\s*'([^']+)'/m)
		if (slugMatch?.[1]) {
			return `${slugMatch[1]}.me`
		}

		const nameMatch = brandContent.match(/name:\s*'([^']+)'/)
		if (!nameMatch) {
			log('⚠️  Could not parse brand name, using default domain', 'yellow')
			return 'menuza.io'
		}

		const brandName = nameMatch[1]
		const domainName = brandName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
		return `${domainName}.me`
	} catch (error) {
		log(`⚠️  Error reading brand config: ${error.message}`, 'yellow')
		return 'menuza.io'
	}
}

function getLocalDomain() {
	try {
		const brandConfigPath = join(rootDir, 'packages/config/brand.ts')
		const brandContent = readFileSync(brandConfigPath, 'utf-8')
		const slugMatch = brandContent.match(/^\tslug:\s*'([^']+)'/m)
		if (slugMatch?.[1]) return `${slugMatch[1]}.test`
	} catch (error) {
		log(`⚠️  Could not derive local domain: ${error.message}`, 'yellow')
	}

	return `${getBrandDomain().split('.')[0]}.test`
}

function getDefaultDatabaseUrl() {
	const dbPath = join(rootDir, 'packages/database/db/data.db')
	return `file:${dbPath}?connection_limit=1`
}

/**
 * Load published org Sites hostnames: slug subdomains + custom domains.
 */
async function getOrganizationSiteHosts() {
	const databaseUrl = process.env.DATABASE_URL || getDefaultDatabaseUrl()
	const url = databaseUrl.replace(/\?.*$/, '')
	const client = createClient({ url })

	try {
		const result = await client.execute(
			`SELECT slug, customDomain FROM "Organization" WHERE active = 1 AND sitePublished = 1 ORDER BY slug ASC`,
		)
		const organizations = result.rows

		const orgSlugs = organizations
			.map((org) => org.slug)
			.filter(
				(slug) =>
					typeof slug === 'string' &&
					slug.length > 0 &&
					!RESERVED_SUBDOMAINS.has(slug),
			)

		const customDomains = organizations
			.map((org) => org.customDomain)
			.filter((value) => typeof value === 'string' && value.length > 0)

		return { orgSlugs, customDomains }
	} catch (error) {
		log(
			`⚠️  Could not load organization sites from the database: ${error.message}`,
			'yellow',
		)
		log(
			'   Product app hosts will still be added. Re-run after migrate/seed.',
			'gray',
		)
		return { orgSlugs: [], customDomains: [] }
	} finally {
		client.close()
	}
}

async function getHostsEntries(domain) {
	const ip = '127.0.0.1'
	const { orgSlugs, customDomains } = await getOrganizationSiteHosts()

	if (orgSlugs.length > 0) {
		log(
			`Found ${orgSlugs.length} published organization site(s) for hosts`,
			'blue',
		)
	} else {
		log(
			'No published organization sites found (publish from org settings, then re-run)',
			'yellow',
		)
	}

	if (customDomains.length > 0) {
		log(
			`Skipping ${customDomains.length} public custom domain(s) to avoid shadowing DNS`,
			'yellow',
		)
	}

	const brandHostnames = [
		...PRODUCT_SUBDOMAINS.map((subdomain) => `${subdomain}${domain}`),
		...orgSlugs.map((slug) => `${slug}.${domain}`),
	]

	return {
		orgSlugs,
		customDomains,
		entries: brandHostnames.map((hostname) => ({
			ip,
			hostname,
			entry: `${ip} ${hostname}`,
		})),
	}
}

function removeLegacyHostsEntries(domain, orgSlugs, customDomains) {
	const legacyHostnames = new Set([
		...PRODUCT_SUBDOMAINS.map((subdomain) => `${subdomain}${domain}`),
		...orgSlugs.map((slug) => `${slug}.${domain}`),
		...customDomains.filter(
			(d) =>
				d &&
				!d.endsWith('.localhost') &&
				d !== 'localhost' &&
				!d.endsWith('.test'),
		),
	])
	const hostsContent = readFileSync('/etc/hosts', 'utf-8')
	let changed = false
	const nextContent = hostsContent
		.split('\n')
		.map((line) => {
			const commentIndex = line.indexOf('#')
			const body = commentIndex === -1 ? line : line.slice(0, commentIndex)
			const comment = commentIndex === -1 ? '' : line.slice(commentIndex)
			const fields = body.trim().split(/\s+/)
			if (fields[0] !== '127.0.0.1') return line

			const remainingHosts = fields
				.slice(1)
				.filter((hostname) => !legacyHostnames.has(hostname))
			if (remainingHosts.length === fields.length - 1) return line

			changed = true
			if (remainingHosts.length === 0) return comment
			return `127.0.0.1 ${remainingHosts.join(' ')}${comment ? ` ${comment}` : ''}`
		})
		.join('\n')

	if (!changed) return

	const temporaryDirectory = mkdtempSync(join(tmpdir(), 'epic-hosts-'))
	const temporaryHostsPath = join(temporaryDirectory, 'hosts')
	try {
		writeFileSync(temporaryHostsPath, nextContent, 'utf-8')
		execFileSync('sudo', ['cp', temporaryHostsPath, '/etc/hosts'], {
			stdio: 'inherit',
		})
		log(`✅ Removed legacy local entries for ${domain}`, 'green')
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true })
	}
}

function checkHostsEntry(entry) {
	try {
		const hostsContent = readFileSync('/etc/hosts', 'utf-8')
		// Check if the exact entry exists (with proper spacing)
		const regex = new RegExp(`^\\s*${entry.ip}\\s+${entry.hostname}\\s*$`, 'm')
		return regex.test(hostsContent)
	} catch (error) {
		log(`⚠️  Could not read /etc/hosts: ${error.message}`, 'yellow')
		return false
	}
}

function addHostsEntry(entry) {
	try {
		execSync(`sudo -- sh -c -e "echo '${entry.entry}' >> /etc/hosts"`, {
			stdio: 'inherit',
		})
		return true
	} catch (error) {
		log(`⚠️  Failed to add hosts entry: ${error.message}`, 'yellow')
		return false
	}
}

async function main() {
	log('\n🌐 Setting up local development domains...', 'bright')

	const domain = getLocalDomain()
	log(`Using local domain: ${domain}`, 'blue')

	const { orgSlugs, customDomains, entries } = await getHostsEntries(domain)
	try {
		removeLegacyHostsEntries(
			`${domain.split('.')[0]}.me`,
			orgSlugs,
			customDomains,
		)
	} catch (error) {
		log(`⚠️  Could not remove legacy hosts entries: ${error.message}`, 'yellow')
	}

	log(
		'\nThis script will add entries to your /etc/hosts file for local development.',
		'gray',
	)
	log('Sudo password may be required.\n', 'gray')

	let addedCount = 0
	let existingCount = 0

	for (const entry of entries) {
		if (checkHostsEntry(entry)) {
			log(
				`✓ Entry for '${entry.hostname}' already exists in /etc/hosts`,
				'gray',
			)
			existingCount++
		} else {
			if (addHostsEntry(entry)) {
				log(`✅ Added '${entry.entry}' to /etc/hosts`, 'green')
				addedCount++
			}
		}
	}

	log(`\n✓ Hosts setup complete!`, 'green')
	log(`  Added: ${addedCount} entries`, 'gray')
	log(`  Existing: ${existingCount} entries`, 'gray')

	if (addedCount > 0 || existingCount > 0) {
		log(`\n💡 You can now access your apps at:`, 'blue')
		log(`  Main site: https://${domain}:2999`, 'gray')
		log(`  App: https://app.${domain}:2999`, 'gray')
		log(`  Admin: https://admin.${domain}:2999`, 'gray')
		log(`  Studio: https://studio.${domain}:2999`, 'gray')
		log(`  Docs: https://docs.${domain}:2999`, 'gray')

		if (orgSlugs.length > 0) {
			log(`\n  Organization Sites:`, 'blue')
			for (const slug of orgSlugs) {
				log(`  https://${slug}.${domain}:2999`, 'gray')
			}
		}

		log(
			`\n  Tip: Re-run npm run setup:hosts after publishing sites or connecting domains.`,
			'gray',
		)
		log(
			`  For full *.${domain} local DNS, use dnsmasq (hosts cannot wildcard).`,
			'gray',
		)
	}
}

main().catch((error) => {
	log(`\n❌ Hosts setup failed: ${error.message}`, 'red')
	process.exit(1)
})
