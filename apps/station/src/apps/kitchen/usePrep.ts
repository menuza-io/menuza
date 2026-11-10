import { type PrepPlan, type PrepTask } from '@repo/inventory'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StockApiError } from '../stock/api.ts'
import { stockApiFor } from '../stock/sync.ts'
import { doneBody } from './prep-model.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** The plan is read again this often while the screen is open. */
const REFRESH_MS = 60_000

export type PrepState = {
	/** `null` until the region has answered once; `false` when prep is not switched on for the organization. */
	available: boolean | null
	plan: PrepPlan | null
	/** A code the screen can say in words (`connection_lost`, `stale_version`, ...). */
	error: string | null
	/** The task being changed, or `generate`. */
	busy: string | null
	refresh: () => Promise<void>
	start: (task: PrepTask) => Promise<void>
	skip: (task: PrepTask) => Promise<void>
	done: (
		task: PrepTask,
		answer: { kind: 'batches' | 'amount'; value: number },
		clientId: string,
	) => Promise<boolean>
}

/** Codes that mean prep is simply not there for this organization (not a fault to show). */
const NOT_AVAILABLE = new Set(['inventory_disabled', 'inventory_not_enabled'])

/**
 * Kitchen prep: the day's plan for this terminal's location (and the screen's
 * station), refreshed every minute, with the three things a cook does with a
 * task. Online only, by the Kitchen rules: a write is never queued, and after
 * any answer (even a failed or uncertain one) the plan is read again so the
 * screen shows what the region has, never a guess. Plans the day when nobody
 * has.
 */
export function usePrep(
	settings: PosSettings,
	session: Session | null,
	online: boolean,
	stationId: string | null,
): PrepState {
	const locationId = settings.locationId
	const token = session?.serverSession?.token ?? null
	const enabled =
		settings.apps.inventory &&
		Boolean(locationId) &&
		(settings.demo || (online && token !== null))
	const api = useMemo(
		() => stockApiFor(settings, session),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[settings.demo, settings.tenantApiUrl, settings.deviceToken, token],
	)
	const [available, setAvailable] = useState<boolean | null>(null)
	const [plan, setPlan] = useState<PrepPlan | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const generated = useRef(new Set<string>())
	const alive = useRef(true)
	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
		}
	}, [])

	const refresh = useCallback(async () => {
		if (!enabled || !locationId) return
		try {
			let next = await api.prepPlan(locationId, stationId)
			// Nobody has planned this day yet: do it (once per day here).
			const key = `${next.locationId}:${next.date}`
			if (!next.generated && next.canGenerate && !generated.current.has(key)) {
				generated.current.add(key)
				await api.prepGenerate({ locationId, date: next.date })
				next = await api.prepPlan(locationId, stationId)
			}
			if (!alive.current) return
			setPlan(next)
			setAvailable(true)
			setError(null)
		} catch (caught) {
			if (!alive.current) return
			const code = caught instanceof StockApiError ? caught.code : 'unknown'
			if (NOT_AVAILABLE.has(code)) {
				setAvailable(false)
				setPlan(null)
				return
			}
			setError(code)
		}
	}, [api, enabled, locationId, stationId])

	useEffect(() => {
		if (!enabled) return
		void refresh()
		const timer = window.setInterval(() => void refresh(), REFRESH_MS)
		return () => window.clearInterval(timer)
	}, [enabled, refresh])

	/** Runs a write, then reads the plan back whatever happened. */
	const write = useCallback(
		async (id: string, run: () => Promise<unknown>): Promise<boolean> => {
			setBusy(id)
			setError(null)
			let ok = false
			try {
				await run()
				ok = true
			} catch (caught) {
				setError(caught instanceof StockApiError ? caught.code : 'unknown')
			} finally {
				setBusy(null)
			}
			await refresh()
			return ok
		},
		[refresh],
	)

	return {
		available,
		plan,
		error,
		busy,
		refresh,
		start: async (task) => {
			await write(task.id, () =>
				api.prepStart(task.id, { expectedVersion: task.version }),
			)
		},
		skip: async (task) => {
			await write(task.id, () =>
				api.prepSkip(task.id, { expectedVersion: task.version }),
			)
		},
		done: (task, answer, clientId) =>
			write(task.id, () =>
				api.prepDone(task.id, doneBody(task, answer, clientId)),
			),
	}
}
