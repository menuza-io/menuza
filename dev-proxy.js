const https = require('https')
const http = require('http')
const fs = require('fs')
const httpProxy = require('http-proxy')

const useHttp =
	process.env.PROXY_PROTOCOL === 'http' || process.argv.includes('--http')
const protocol = useHttp ? 'http' : 'https'
const port = 2999

// Function to get domain from brand configuration
function getBrandDomain() {
	try {
		const fs = require('fs')
		const path = require('path')
		const brandConfigPath = path.join(__dirname, 'packages/config/brand.ts')

		if (!fs.existsSync(brandConfigPath)) {
			console.log('⚠️  Brand config not found, using default domain')
			return 'epic-startup.com'
		}

		const brandContent = fs.readFileSync(brandConfigPath, 'utf-8')
		const domainMatch = brandContent.match(/^\tdomain:\s*'([^']+)'/m)
		if (domainMatch && domainMatch[1]) {
			return domainMatch[1]
		}

		const slugMatch = brandContent.match(/^\tslug:\s*'([^']+)'/m)
		if (slugMatch && slugMatch[1]) {
			return `${slugMatch[1]}.me`
		}

		const nameMatch = brandContent.match(/name:\s*'([^']+)'/)
		if (!nameMatch) {
			console.log('⚠️  Could not parse brand name, using default domain')
			return 'epic-startup.com'
		}

		const brandName = nameMatch[1]
		const domainName = brandName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
		return `${domainName}.me`
	} catch (error) {
		console.log(`⚠️  Error reading brand config: ${error.message}`)
		return 'epic-startup.com'
	}
}

function getLocalDomain() {
	try {
		const path = require('path')
		const brandConfigPath = path.join(__dirname, 'packages/config/brand.ts')
		const brandContent = fs.readFileSync(brandConfigPath, 'utf-8')
		const slugMatch = brandContent.match(/^\tslug:\s*'([^']+)'/m)
		if (slugMatch && slugMatch[1]) return `${slugMatch[1]}.test`
	} catch (error) {
		console.log(`⚠️  Could not derive local domain: ${error.message}`)
	}

	return `${getBrandDomain().split('.')[0]}.test`
}

const domain = getLocalDomain()

// Reserved product subdomains — everything else under *.{domain} is Sites
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

const SITES_TARGET = 'http://localhost:3008'

// Target mappings
const targets = {
	[`${domain}:${port}`]: 'http://localhost:3002',
	[`app.${domain}:${port}`]: 'http://localhost:3001',
	[`studio.${domain}:${port}`]: 'http://localhost:3003',
	[`docs.${domain}:${port}`]: 'http://localhost:3004',
	[`admin.${domain}:${port}`]: 'http://localhost:3005',
	[`api.${domain}:${port}`]: 'http://localhost:3007',
	[`api-ksa.${domain}:${port}`]: 'http://localhost:3009',
}

/**
 * Resolve proxy target: exact product apps first, then org Sites catch-all
 * (brand subdomains + arbitrary custom domains for local Sites testing).
 */
function resolveTarget(host) {
	if (!host) return null
	if (targets[host]) return targets[host]

	const hostWithoutPort = host.split(':')[0] || ''
	const suffix = `.${domain}`

	if (hostWithoutPort.endsWith(suffix)) {
		const subdomain = hostWithoutPort.slice(0, -suffix.length)
		if (
			!subdomain ||
			subdomain.includes('.') ||
			RESERVED_SUBDOMAINS.has(subdomain)
		) {
			return null
		}
		return SITES_TARGET
	}

	// Local custom domains (e.g. www.acme.test:2999) → Sites
	if (
		hostWithoutPort &&
		hostWithoutPort !== 'localhost' &&
		!hostWithoutPort.startsWith('127.')
	) {
		return SITES_TARGET
	}

	return null
}

console.table({
	...targets,
	[`*.${domain}:${port}`]: SITES_TARGET,
	[`<custom-domain>:${port}`]: SITES_TARGET,
})

const proxy = httpProxy.createProxyServer({
	ws: true,
	xfwd: true,
})

// Global error handler to prevent crashes
proxy.on('error', (err, req, res) => {
	if (err.code === 'ECONNREFUSED') {
		console.log(`⏳ Waiting for backend to start...`)
		// Response might already be handled, check if writable
		if (res && res.writeHead && !res.headersSent) {
			res.writeHead(503, {
				'Content-Type': 'text/html',
				'Retry-After': '5',
			})
			res.end(`
				<!DOCTYPE html>
				<html>
				<head>
					<title>Service Starting...</title>
					<meta http-equiv="refresh" content="3">
					<style>
						body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
						.container { text-align: center; }
						.spinner { width: 40px; height: 40px; border: 4px solid #333; border-top: 4px solid #6366f1; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
						@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
					</style>
				</head>
				<body>
					<div class="container">
						<div class="spinner"></div>
						<h2>Service Starting...</h2>
						<p>Waiting for backend service to be ready</p>
						<p style="color: #888; font-size: 14px;">This page will auto-refresh</p>
					</div>
				</body>
				</html>
			`)
		}
	} else {
		console.error('Proxy error:', err.message)
	}
})

// Request handler
function requestHandler(req, res) {
	const host = req.headers.host
	const target = resolveTarget(host)

	if (target) {
		req.headers['x-forwarded-proto'] = protocol
		req.headers['x-forwarded-host'] = host
		// Sites resolves the organization slug from the original Host header.
		// Replacing it with localhost:3008 makes every proxied tenant site a 404.
		const changeOrigin = target !== SITES_TARGET
		proxy.web(req, res, { target, changeOrigin }, (err) => {
			if (err.code === 'ECONNREFUSED') {
				console.log(`⏳ Waiting for ${target} to start...`)
				res.writeHead(503, {
					'Content-Type': 'text/html',
					'Retry-After': '5',
				})
				res.end(`
					<!DOCTYPE html>
					<html>
					<head>
						<title>Service Starting...</title>
						<meta http-equiv="refresh" content="3">
						<style>
							body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
							.container { text-align: center; }
							.spinner { width: 40px; height: 40px; border: 4px solid #333; border-top: 4px solid #6366f1; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
							@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
						</style>
					</head>
					<body>
						<div class="container">
							<div class="spinner"></div>
							<h2>Service Starting...</h2>
							<p>Waiting for <code>${target}</code> to be ready</p>
							<p style="color: #888; font-size: 14px;">This page will auto-refresh</p>
						</div>
					</body>
					</html>
				`)
			} else {
				console.error('Proxy error for:', req.url, err)
				res.writeHead(500, { 'Content-Type': 'text/plain' })
				res.end('Proxy error: ' + err.message)
			}
		})
	} else {
		res.writeHead(404, { 'Content-Type': 'text/plain' })
		res.end('Not Found')
	}
}

// WebSocket upgrade handler
function upgradeHandler(req, socket, head) {
	const host = req.headers.host
	const target = resolveTarget(host)
	if (target) {
		req.headers['x-forwarded-proto'] = protocol
		req.headers['x-forwarded-host'] = host
		const changeOrigin = target !== SITES_TARGET
		proxy.ws(req, socket, head, { target, changeOrigin })
	} else {
		socket.destroy()
	}
}

// Create server based on protocol
let server
if (useHttp) {
	server = http.createServer(requestHandler)
} else {
	const sslOptions = {
		key: fs.readFileSync('./other/ssl/_wildcard.domain.me+2-key.pem'),
		cert: fs.readFileSync('./other/ssl/_wildcard.domain.me+2.pem'),
	}
	server = https.createServer(sslOptions, requestHandler)
}

server.on('upgrade', upgradeHandler)

server.listen(port, '127.0.0.1', () => {
	console.log(`HTTPS Reverse proxy listening on port ${port}`)
})
