#!/usr/bin/env node
/**
 * Free the ports used by `npm run dev` so leftover processes don't block startup.
 */

import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/** Ports started by `dev` / `dev:http` (proxy + turbo filters + KSA tenant-api). */
const DEV_PORTS = [
	{ port: 2999, name: 'dev proxy' },
	{ port: 3001, name: 'app' },
	{ port: 3002, name: 'web' },
	{ port: 3003, name: 'studio' },
	{ port: 3004, name: 'docs' },
	{ port: 3005, name: 'admin' },
	{ port: 3007, name: 'tenant-api (US)' },
	{ port: 3008, name: 'sites' },
	{ port: 3009, name: 'tenant-api (KSA)' },
	{ port: 3010, name: 'station' },
	{ port: 8787, name: 'jobs-cron' },
	{ port: 24678, name: 'admin Vite HMR' },
	{ port: 24679, name: 'app Vite HMR' },
]

const protectedPids = new Set([String(process.pid), String(process.ppid)])

function pidsListeningOn(port) {
	try {
		const output = execFileSync(
			'lsof',
			['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
		)
		return [
			...new Set(
				output
					.trim()
					.split(/\s+/u)
					.filter((pid) => pid && !protectedPids.has(pid)),
			),
		]
	} catch {
		return []
	}
}

function isAlive(pid) {
	try {
		process.kill(Number(pid), 0)
		return true
	} catch {
		return false
	}
}

function signal(pid, sig) {
	try {
		process.kill(Number(pid), sig)
		return true
	} catch {
		return false
	}
}

async function freePort({ port, name }) {
	const pids = pidsListeningOn(port)
	if (pids.length === 0) return false

	for (const pid of pids) signal(pid, 'SIGTERM')
	await delay(300)

	for (const pid of pids) {
		if (isAlive(pid)) signal(pid, 'SIGKILL')
	}

	const stillListening = pidsListeningOn(port)
	if (stillListening.length > 0) {
		console.warn(
			`  ⚠️  :${port} (${name}) still held by PID ${stillListening.join(', ')}`,
		)
		return false
	}

	console.log(`  ✓ killed :${port} (${name}) — PID ${pids.join(', ')}`)
	return true
}

const killed = []
for (const entry of DEV_PORTS) {
	if (await freePort(entry)) killed.push(entry.port)
}

if (killed.length === 0) {
	console.log('Dev ports are free.')
} else {
	// Give the OS a beat to fully release the sockets before servers bind.
	await delay(150)
	console.log(`Freed ${killed.length} port${killed.length === 1 ? '' : 's'}.`)
}
