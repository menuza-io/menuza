/** @jest-environment node */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(__dirname, '..')
const script = join(root, 'scripts/generate-tenant.mjs')

const config = {
	slug: 'registry-test',
	displayName: 'Registry Test',
	bundleId: 'com.example.registrytest',
	androidPackage: 'com.example.registrytest',
	marketingVersion: '1.0.0',
	appUrl: 'localhost:3001',
	tenantApiUs: '',
	tenantApiKsa: 'localhost:3009',
	dataRegion: 'ksa',
	site: {
		slug: 'registry-test',
		host: 'registry-test.menuza.test',
		origin: 'http://registry-test.menuza.test',
	},
}

let server: Server
let base = ''
const seen: Array<{ url: string; auth: string | undefined }> = []

beforeAll(async () => {
	server = createServer((request, response) => {
		seen.push({ url: request.url ?? '', auth: request.headers.authorization })
		if (request.headers.authorization !== 'Bearer test-token-test-token') {
			response.writeHead(401).end()
			return
		}
		if (!request.url?.includes('slug=registry-test')) {
			response.writeHead(404).end()
			return
		}
		response
			.writeHead(200, { 'Content-Type': 'application/json' })
			.end(JSON.stringify(config))
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
afterAll(() => {
	server.close()
	rmSync(join(root, 'tenants/generated/registry-test'), {
		recursive: true,
		force: true,
	})
})

describe('generate-tenant --registry (#156)', () => {
	it('reads the config from the registry instead of a committed file', async () => {
		const { stdout } = await run(
			'node',
			[
				script,
				'--tenant',
				'registry-test',
				'--registry',
				'--registry-url',
				base,
				'--no-icon',
				'--no-api',
			],
			{
				env: {
					...process.env,
					INTERNAL_COMMAND_TOKEN: 'test-token-test-token',
				},
			},
		)
		expect(stdout).toContain('Registry Test')
		const written = join(root, 'tenants/generated/registry-test/tenant.json')
		expect(existsSync(written)).toBe(true)
		const file = JSON.parse(readFileSync(written, 'utf8'))
		expect(file).toMatchObject({
			bundleId: 'com.example.registrytest',
			tenantApiKsa: 'localhost:3009',
		})
		// The token is sent as a bearer and never written to disk or printed.
		expect(seen.at(-1)?.auth).toBe('Bearer test-token-test-token')
		expect(readFileSync(written, 'utf8')).not.toContain('test-token')
		expect(stdout).not.toContain('test-token')
		expect(existsSync(join(root, 'tenants/registry-test.json'))).toBe(false)
	})

	it('fails without printing the token when the registry refuses it', async () => {
		await expect(
			run(
				'node',
				[
					script,
					'--tenant',
					'registry-test',
					'--registry',
					'--registry-url',
					base,
					'--no-icon',
					'--no-api',
				],
				{
					env: {
						...process.env,
						INTERNAL_COMMAND_TOKEN: 'wrong-wrong-wrong-wrong',
					},
				},
			),
		).rejects.toMatchObject({ stderr: expect.stringContaining('401') })
	})

	it('needs the token in the environment', async () => {
		const env = { ...process.env }
		delete env.INTERNAL_COMMAND_TOKEN
		await expect(
			run(
				'node',
				[
					script,
					'--tenant',
					'registry-test',
					'--registry',
					'--registry-url',
					base,
				],
				{ env },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining('INTERNAL_COMMAND_TOKEN'),
		})
	})
})
