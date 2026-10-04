#!/usr/bin/env node
/**
 * Wrangler dev reads `.dev.vars`, not Varlock directly. Mirror resolved secrets
 * from the app's env schema before `vite dev` (Cloudflare runtime).
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const env = execFileSync(
	'npx',
	['varlock', 'load', '--format', 'env', '--compact', '--env', 'development'],
	{ cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)

writeFileSync(join(appDir, '.dev.vars'), env)
