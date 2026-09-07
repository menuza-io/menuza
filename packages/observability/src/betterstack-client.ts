import { LRUCache } from 'lru-cache'
import { MonitorsResponseSchema, type StatusInfo } from './types.js'

const BETTERSTACK_BASE_URL = 'https://uptime.betterstack.com/api/v2'
const CACHE_TTL = 60_000 // 1 minute cache

interface CachedStatus {
	status: StatusInfo
	timestamp: number
}

// Create a simple in-memory cache for status
const statusCache = new LRUCache<string, CachedStatus>({
	max: 10,
	ttl: CACHE_TTL,
})

export async function getUptimeStatus(
	apiKey: string,
	statusPageUrl?: string,
): Promise<StatusInfo> {
	if (!apiKey) {
		return {
			status: 'degraded',
			message: 'Unable to fetch status',
			upMonitors: 0,
			totalMonitors: 0,
		}
	}

	const cacheKey = `status:${apiKey}:${statusPageUrl || 'default'}`

	// Check cache first
	const cached = statusCache.get(cacheKey)
	if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
		return cached.status
	}

	try {
		// Fetch monitors from BetterStack
		const response = await fetch(`${BETTERSTACK_BASE_URL}/monitors`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
		})

		if (!response.ok) {
			throw new Error(`BetterStack API error: ${response.statusText}`)
		}

		const data = await response.json()
		const parsedData = MonitorsResponseSchema.parse(data)

		const monitors = parsedData.data
		const upMonitors = monitors.filter(
			(m) => m.attributes.status === 'up',
		).length
		const totalMonitors = monitors.length

		let status: StatusInfo['status']
		let message: string

		if (upMonitors === totalMonitors) {
			status = 'operational'
			message = 'All systems normal'
		} else if (upMonitors === 0) {
			status = 'degraded'
			message = 'Major outage'
		} else {
			status = 'partial_outage'
			message = 'Partial outage'
		}

		const statusInfo: StatusInfo = {
			status,
			message,
			upMonitors,
			totalMonitors,
		}

		// Cache the result
		statusCache.set(cacheKey, { status: statusInfo, timestamp: Date.now() })

		return statusInfo
	} catch (error) {
		console.error('Error fetching uptime status:', error)
		// Return a degraded status on error
		return {
			status: 'degraded',
			message: 'Unable to fetch status',
			upMonitors: 0,
			totalMonitors: 0,
		}
	}
}
