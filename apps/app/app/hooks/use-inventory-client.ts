import { useCallback, useContext, useEffect, useState } from 'react'
import { type z } from 'zod'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'

/** The regional inventory client for the current organization. */
export function useInventoryClient(): InventoryClient {
	const client = useContext(InventoryClientContext)
	if (!client) {
		throw new Error(
			'useInventoryClient must be used within an InventoryClientProvider',
		)
	}
	return client
}

export type InventoryQuery<T> = {
	data: T | null
	error: Error | null
	/** True until the first response; stays false while refreshing. */
	loading: boolean
	refreshing: boolean
	reload: () => void
}

function pathLocationId(path: string | null): string | null {
	if (path === null) return null
	const qIndex = path.indexOf('?')
	if (qIndex < 0) return null
	return new URLSearchParams(path.slice(qIndex + 1)).get('locationId')
}

/**
 * GET an inventory resource and parse it, with the loading, error and refresh
 * conventions of `useStaffQuery`: previous data stays on screen while a new
 * request runs within the same location, and is cleared when switching
 * `locationId` so a branch switch never flashes another branch's figures.
 * Pass `null` for `path` to wait.
 */
export function useInventoryQuery<S extends z.ZodTypeAny>(
	path: string | null,
	schema: S,
): InventoryQuery<z.infer<S>> {
	const { request } = useInventoryClient()
	const [state, setState] = useState<{
		path: string | null
		data: z.infer<S> | null
		error: Error | null
		loading: boolean
		refreshing: boolean
	}>({
		path,
		data: null,
		error: null,
		loading: path !== null,
		refreshing: false,
	})
	const [tick, setTick] = useState(0)

	const sameLocation = pathLocationId(path) === pathLocationId(state.path)

	useEffect(() => {
		if (path === null) return
		let live = true
		setState((current) => {
			const keepData =
				pathLocationId(path) === pathLocationId(current.path)
			const data = keepData ? current.data : null
			return {
				path,
				data,
				error: null,
				loading: data === null,
				refreshing: data !== null,
			}
		})
		request(path).then(
			(body) => {
				if (!live) return
				const parsed = schema.safeParse(body)
				setState(
					parsed.success
						? {
								path,
								data: parsed.data,
								error: null,
								loading: false,
								refreshing: false,
							}
						: {
								path,
								data: null,
								error: new Error('malformed_response'),
								loading: false,
								refreshing: false,
							},
				)
			},
			(error: unknown) => {
				if (!live) return
				setState((current) => ({
					...current,
					path,
					error: error instanceof Error ? error : new Error('request_failed'),
					loading: false,
					refreshing: false,
				}))
			},
		)
		return () => {
			live = false
		}
		// `schema` is a module-level constant at every call site.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [request, path, tick])

	const reload = useCallback(() => setTick((value) => value + 1), [])
	if (path === null) {
		return {
			data: null,
			error: null,
			loading: false,
			refreshing: false,
			reload,
		}
	}
	if (!sameLocation) {
		return {
			data: null,
			error: null,
			loading: true,
			refreshing: false,
			reload,
		}
	}
	return {
		data: state.data,
		error: state.error,
		loading: state.loading,
		refreshing: state.refreshing,
		reload,
	}
}
