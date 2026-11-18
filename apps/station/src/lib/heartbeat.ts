import {
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_RECHECK_MS,
	type Heartbeat,
} from '@repo/common/device-health'
import { type PosSettings } from './config.ts'
import { getMeta } from './db.ts'
import { LAST_UPLOAD_KEY, pendingCount } from './outbox.ts'
import { openShift } from './shifts.ts'

/**
 * Connection history (#356). While the app is open the terminal tells the
 * region it is alive, at most once a minute: version, browser, battery,
 * storage, how many orders wait to upload and when it last delivered one. No
 * staff names, no order contents. A browser cannot read a receipt printer or
 * the cash drawer, so neither is reported; the region shows them only if a
 * future print path fills them in.
 */

declare const __STATION_VERSION__: string | undefined

/** "Chrome 130", "Safari 17", "Firefox 131", "Edge 130": the family and major version. */
export function browserLabel(userAgent: string): string | null {
	const pick = (re: RegExp, name: string) => {
		const match = re.exec(userAgent)
		return match ? `${name} ${match[1]}` : null
	}
	return (
		pick(/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge') ??
		pick(/\bFirefox\/(\d+)/, 'Firefox') ??
		pick(/\b(?:Chrome|CriOS)\/(\d+)/, 'Chrome') ??
		pick(/\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/, 'Safari') ??
		null
	)
}

type BatteryManager = { level: number; charging: boolean }

export type HeartbeatInputs = {
	appVersion: string | null
	userAgent: string
	battery: BatteryManager | null
	storage: { usage?: number; quota?: number } | null
	pendingUploads: number
	lastUploadAt: number | null
	openShiftId: string | null
}

const mb = (bytes: number | undefined) =>
	typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
		? Math.round(bytes / (1024 * 1024))
		: null

/** What the browser can truthfully report, as the heartbeat body. */
export function buildHeartbeat(input: HeartbeatInputs): Heartbeat {
	return {
		appVersion: input.appVersion,
		browser: browserLabel(input.userAgent),
		batteryPct: input.battery
			? Math.max(0, Math.min(100, Math.round(input.battery.level * 100)))
			: null,
		charging: input.battery ? input.battery.charging : null,
		storageUsedMb: mb(input.storage?.usage),
		storageQuotaMb: mb(input.storage?.quota),
		pendingUploads: Math.max(0, Math.floor(input.pendingUploads)),
		lastUploadAt: input.lastUploadAt,
		// The shift the till has open (an id). Printer and drawer are not read.
		drawerShiftId: input.openShiftId,
	}
}

async function readInputs(): Promise<HeartbeatInputs> {
	const nav = navigator as Navigator & {
		getBattery?: () => Promise<BatteryManager>
	}
	const [battery, storage, pendingUploads, lastUploadAt, shift] =
		await Promise.all([
			nav.getBattery?.().catch(() => null) ?? null,
			nav.storage?.estimate?.().catch(() => null) ?? null,
			pendingCount().catch(() => 0),
			getMeta<number>(LAST_UPLOAD_KEY).catch(() => undefined),
			openShift().catch(() => undefined),
		])
	return {
		appVersion:
			typeof __STATION_VERSION__ === 'string' ? __STATION_VERSION__ : null,
		userAgent: navigator.userAgent,
		battery,
		storage,
		pendingUploads,
		lastUploadAt: typeof lastUploadAt === 'number' ? lastUploadAt : null,
		openShiftId: shift?.id ?? null,
	}
}

/** Sends one heartbeat. `enabled: false` means the region does not collect history for this organization. */
export async function sendHeartbeat(
	settings: Pick<PosSettings, 'tenantApiUrl' | 'deviceToken'>,
	body: Heartbeat,
	fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<{ enabled: boolean } | null> {
	if (!settings.tenantApiUrl || !settings.deviceToken) return null
	try {
		const response = await fetchImpl(
			`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/heartbeat`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${settings.deviceToken}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(8_000),
			},
		)
		if (!response.ok) return null
		const answer = (await response.json().catch(() => null)) as {
			enabled?: unknown
		} | null
		return { enabled: answer?.enabled === true }
	} catch {
		return null
	}
}

/**
 * Keeps a heartbeat going while the app is open and paired: every minute, and
 * every ten minutes while the region says it is not collecting. Returns the
 * function that stops it. Never while training (nothing leaves a training
 * till) or in demo mode.
 */
export function startHeartbeat(
	getSettings: () => PosSettings,
	options: {
		isTraining: () => boolean
		send?: typeof sendHeartbeat
		now?: () => number
	},
): () => void {
	const send = options.send ?? sendHeartbeat
	const now = options.now ?? Date.now
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | null = null
	let lastSentAt = 0
	const schedule = (ms: number) => {
		if (stopped) return
		timer = setTimeout(() => void tick(), ms)
	}
	const tick = async () => {
		if (stopped) return
		const settings = getSettings()
		const quiet =
			options.isTraining() ||
			settings.demo ||
			!settings.deviceToken ||
			!settings.tenantApiUrl ||
			(typeof document !== 'undefined' && document.visibilityState === 'hidden')
		// At most once a minute, whatever else wakes this up.
		if (quiet || now() - lastSentAt < HEARTBEAT_INTERVAL_MS) {
			schedule(HEARTBEAT_INTERVAL_MS)
			return
		}
		lastSentAt = now()
		const answer = await send(settings, buildHeartbeat(await readInputs()))
		schedule(
			answer && !answer.enabled ? HEARTBEAT_RECHECK_MS : HEARTBEAT_INTERVAL_MS,
		)
	}
	schedule(5_000)
	return () => {
		stopped = true
		if (timer) clearTimeout(timer)
	}
}
