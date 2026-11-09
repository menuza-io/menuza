import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	INVENTORY_PERMISSIONS,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
	type InventoryScope,
} from '@repo/inventory'
import { type Hono } from 'hono'
import * as jose from 'jose'
import { syncEnvFromProcess } from '../lib/secrets.ts'

/**
 * Shared helpers of the inventory route tests: a tenant database directory,
 * tokens minted with jose, and a JSON client over a Hono app. The control
 * plane mock (`../lib/origin.ts`) stays in each test file, because `vi.mock`
 * only hoists inside the file that calls it.
 */

export const OPERATOR_SECRET = 'inv-test-operator-token-0123456789abcdef'

export const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
export const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
export const COST = INVENTORY_PERMISSIONS.READ_INVENTORY_COST
export const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING

export const ALL_GRANTS: string[] = [READ, UPDATE, COST, PURCHASING]

export function setupTenantEnv(prefix: string): {
	dir: string
	cleanup: () => void
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.INTERNAL_COMMAND_TOKEN = 'inv-test-internal-token-0123456789'
	syncEnvFromProcess()
	return {
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	}
}

export async function mintToken(
	orgId: string,
	options: {
		scope?: InventoryScope
		grants?: string[]
		locationIds?: string[] | null
		impersonated?: boolean
		region?: 'us' | 'ksa'
		subject?: string
	} = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId,
		region: options.region ?? 'us',
		scope: options.scope ?? 'write',
		grants: options.grants ?? ALL_GRANTS,
		locationIds: options.locationIds === undefined ? null : options.locationIds,
		features: {
			enabled: true,
			purchasing: true,
			recipes: false,
			prep: false,
			transfers: false,
		},
		impersonated: options.impersonated ?? false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: INVENTORY_TOKEN_TYP })
		.setSubject(options.subject ?? 'user_owner')
		.setIssuer(brand.shortName)
		.setAudience(INVENTORY_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

export type Reply = { status: number; body: any }

export function makeClient(app: Hono) {
	return async function call(
		method: string,
		requestPath: string,
		options: {
			token: string
			body?: unknown
			headers?: Record<string, string>
		},
	): Promise<Reply> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${options.token}`,
			...options.headers,
		}
		let body: string | undefined
		if (options.body !== undefined) {
			headers['Content-Type'] = 'application/json'
			body = JSON.stringify(options.body)
		}
		const res = await app.request(requestPath, { method, headers, body })
		return { status: res.status, body: await res.json() }
	}
}

let counter = 0
/** A fresh client id that satisfies the contract (8-64 url-safe characters). */
export function cid(prefix = 'cid'): string {
	counter += 1
	return `${prefix}-${Date.now().toString(36)}-${counter}`
}

export const BASE = '/operator/inventory'
