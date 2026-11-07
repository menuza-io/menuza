import fs from 'node:fs'
import http from 'node:http'
import { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { http as mswHttp, passthrough } from 'msw'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { server as mswServer } from '#tests/mocks/index.ts'
import {
	privateAssetsMiddleware,
	routeDiscoveryHandler,
	setPrivateAssetHeaders,
} from './private-client-code.express.server.ts'

/**
 * The Node production server's gate, over real HTTP: the middleware in front
 * of `express.static`, as `server/index.ts` mounts it. Paths are sent raw so
 * the client does not normalize them first.
 */

const SESSION_COOKIE = 'en_session=valid'
const hasSession = async (request: Request) =>
	request.headers.get('cookie') === SESSION_COOKIE

let server: http.Server
let port: number
let root: string

beforeAll(async () => {
	// Mirrors build/client/assets/.
	root = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), 'private-assets-')),
		'assets',
	)
	fs.mkdirSync(path.join(root, 'app'), { recursive: true })
	fs.writeFileSync(path.join(root, 'app', '_layout-abc.js'), 'private')
	fs.writeFileSync(path.join(root, 'login-abc.js'), 'public')
	fs.writeFileSync(path.join(root, 'manifest-abc12345.js'), 'all routes')

	const app = express()
	app.use(privateAssetsMiddleware(hasSession))
	app.get(
		'/__manifest',
		routeDiscoveryHandler(async () => {
			const headers = new Headers()
			headers.append('Set-Cookie', 'a=1; Path=/')
			headers.append('Set-Cookie', 'b=2; Path=/')
			return Response.json(
				{
					'routes/_app+/_layout': {
						id: 'routes/_app+/_layout',
						module: '/assets/app/_layout-abc.js',
					},
				},
				{ headers },
			)
		}, hasSession),
	)
	app.use(
		'/assets',
		express.static(root, {
			fallthrough: false,
			setHeaders: setPrivateAssetHeaders,
		}),
	)
	// Like server/index.ts: the whole client folder is also served at the root.
	app.use(
		express.static(path.dirname(root), { setHeaders: setPrivateAssetHeaders }),
	)
	server = app.listen(0)
	await new Promise((resolve) => server.once('listening', resolve))
	port = (server.address() as AddressInfo).port
})

// Every request in this file goes to the test server, not to anything MSW
// should answer. Match all URLs: MSW reads the raw path //assets/... as a
// protocol-relative URL (host "assets"), so an origin pattern would miss it.
beforeEach(() => {
	mswServer.use(mswHttp.all('*', () => passthrough()))
})

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve))
	fs.rmSync(path.dirname(root), { recursive: true, force: true })
})

function get(rawPath: string, cookie?: string) {
	return new Promise<{
		status: number
		body: string
		headers: http.IncomingHttpHeaders
	}>((resolve, reject) => {
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				path: rawPath,
				headers: cookie ? { Cookie: cookie } : {},
			},
			(res) => {
				let body = ''
				res.on('data', (chunk) => (body += chunk))
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
				)
			},
		)
		req.on('error', reject)
		req.end()
	})
}

describe('Node server private asset gate', () => {
	it('serves a private chunk only with a session, marked private', async () => {
		expect((await get('/assets/app/_layout-abc.js')).status).toBe(404)
		const allowed = await get('/assets/app/_layout-abc.js', SESSION_COOKIE)
		expect(allowed.status).toBe(200)
		expect(allowed.body).toBe('private')
		expect(allowed.headers['cache-control']).toBe(
			'private, max-age=31536000, immutable',
		)
	})

	it.each([
		'/assets/%61pp/_layout-abc.js',
		'/assets//app/_layout-abc.js',
		'/assets/./app/_layout-abc.js',
		'/assets/x/%2e%2e/app/_layout-abc.js',
		'/assets/APP/_layout-abc.js',
		'/assets/app%2f_layout-abc.js',
		'/%61ssets/app/_layout-abc.js',
		'/%41SSETS/APP/_layout-abc.js',
		'//assets/app/_layout-abc.js',
		'/assets/x%23%2f..%2fapp/_layout-abc.js',
		'/assets/x%3f%2f..%2fapp/_layout-abc.js',
	])('never serves %s without a session', async (rawPath) => {
		const response = await get(rawPath)
		expect(response.status).not.toBe(200)
		expect(response.body).not.toBe('private')
	})

	it.each(['/%61ssets/app/_layout-abc.js', '/assets/%61pp/_layout-abc.js'])(
		'marks %s private for a signed-in request',
		async (rawPath) => {
			const response = await get(rawPath, SESSION_COOKIE)
			expect(response.status).toBe(200)
			expect(response.headers['cache-control']).toBe(
				'private, max-age=31536000, immutable',
			)
		},
	)

	it('serves public chunks without a session and hides the route manifest', async () => {
		expect((await get('/assets/login-abc.js')).body).toBe('public')
		expect(
			(await get('/assets/manifest-abc12345.js', SESSION_COOKIE)).status,
		).toBe(404)
		expect((await get('/assets/manifest%2Dabc12345.js')).status).toBe(404)
	})

	it('filters /__manifest and keeps each Set-Cookie header', async () => {
		const anonymous = await get('/__manifest?paths=%2F&version=1')
		expect(anonymous.status).toBe(204)
		expect(anonymous.headers['x-remix-reload-document']).toBe('true')

		const signedIn = await get(
			'/__manifest?paths=%2F&version=1',
			SESSION_COOKIE,
		)
		expect(signedIn.status).toBe(200)
		expect(signedIn.body).toContain('/assets/app/_layout-abc.js')
		expect(signedIn.headers['set-cookie']).toEqual([
			'a=1; Path=/',
			'b=2; Path=/',
		])
	})
})
