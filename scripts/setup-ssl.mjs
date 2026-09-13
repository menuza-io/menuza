#!/usr/bin/env node
/**
 * SSL Certificate setup script
 * Generates local development SSL certificates using mkcert
 */

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

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
	red: '\x1b[31m',
	gray: '\x1b[90m',
}

function log(message, color = 'reset') {
	console.log(`${colors[color]}${message}${colors.reset}`)
}

function checkMkcertInstalled() {
	try {
		execSync('mkcert -version', { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

function installMkcertInstructions() {
	log('\n⚠️  mkcert is not installed.', 'yellow')
	log('\nTo install mkcert:', 'bright')
	log('\n  macOS:', 'green')
	log('    brew install mkcert', 'gray')
	log('    brew install nss  # for Firefox', 'gray')
	log('    mkcert -install', 'gray')
	log('\n  Linux:', 'green')
	log('    # See: https://github.com/FiloSottile/mkcert#linux', 'gray')
	log('\n  Windows:', 'green')
	log('    # See: https://github.com/FiloSottile/mkcert#windows', 'gray')
	log(
		'\nAfter installing, run `mkcert -install` to install the local CA,',
		'yellow',
	)
	log('then run `npm run setup` again.\n', 'yellow')
	process.exit(1)
}

function ensureSSLDirectory() {
	const sslDir = join(rootDir, 'other', 'ssl')
	if (!existsSync(sslDir)) {
		mkdirSync(sslDir, { recursive: true })
		log(`Created SSL directory: ${sslDir}`, 'blue')
	}
	return sslDir
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

function generateCertificates(sslDir) {
	const domain = getLocalDomain()
	log(`🔐 Using local domain: ${domain}`, 'blue')

	const keyPath = join(sslDir, '_wildcard.domain.me+2-key.pem')
	const certPath = join(sslDir, '_wildcard.domain.me+2.pem')

	// Reuse the fixed filenames expected by dev-proxy.js only when the existing
	// certificate already covers the current derived local domain.
	let certificateIsCurrent = false
	if (existsSync(keyPath) && existsSync(certPath)) {
		try {
			const certificateText = execSync(
				`openssl x509 -in "${certPath}" -noout -ext subjectAltName`,
				{ encoding: 'utf8' },
			)
			certificateIsCurrent = certificateText.includes(`DNS:${domain}`)
		} catch {
			certificateIsCurrent = false
		}
	}

	if (certificateIsCurrent) {
		log('\n✓ SSL certificates already exist', 'green')
		log(`  Key: ${keyPath}`, 'gray')
		log(`  Cert: ${certPath}`, 'gray')
		return
	}

	log('\n🔐 Generating SSL certificates...', 'blue')

	try {
		// Generate wildcard certificate for all subdomains
		// mkcert will generate files like: _wildcard.domain.me+2-key.pem and _wildcard.domain.me+2.pem
		const domains = [`*.${domain}`, domain]
		execSync(
			`mkcert -key-file "${keyPath}" -cert-file "${certPath}" ${domains.join(' ')}`,
			{ cwd: sslDir, stdio: 'inherit' },
		)

		log('\n✓ SSL certificates generated successfully!', 'green')
		log(`  Key: ${keyPath}`, 'gray')
		log(`  Cert: ${certPath}`, 'gray')
	} catch (error) {
		log('\n✗ Failed to generate SSL certificates', 'red')
		log(`  Error: ${error.message}`, 'red')
		process.exit(1)
	}
}

async function main() {
	log('\n🔐 Setting up SSL certificates for local development...', 'bright')

	// Check if mkcert is installed
	if (!checkMkcertInstalled()) {
		installMkcertInstructions()
		return
	}

	// Ensure SSL directory exists
	const sslDir = ensureSSLDirectory()

	// Generate certificates
	generateCertificates(sslDir)

	log('\n✓ SSL setup complete!\n', 'green')
}

main().catch((error) => {
	log(`\n✗ SSL setup failed: ${error.message}`, 'red')
	process.exit(1)
})
