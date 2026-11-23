import { useCallback, useEffect, useRef, useState } from 'react'
import { type z } from 'zod'
import { type RegionClient, RegionError } from '../lib/inventory/region-client'

export interface RegionQuery<T> {
	data: T | null
	error: RegionError | Error | null
	loading: boolean
	reload: () => void
}

/**
 * GET a regional resource and parse it with its shared schema. Previous data
 * stays on screen while a new request runs. Pass `null` as the path to wait
 * (no location yet).
 */
export function useRegionQuery<S extends z.ZodTypeAny>(
	client: RegionClient | null,
	path: string | null,
	schema: S,
): RegionQuery<z.infer<S>> {
	const [state, setState] = useState<{
		data: z.infer<S> | null
		error: RegionError | Error | null
		loading: boolean
	}>({ data: null, error: null, loading: path !== null })
	const [attempt, setAttempt] = useState(0)
	const schemaRef = useRef(schema)
	schemaRef.current = schema

	useEffect(() => {
		if (!client || path === null) {
			setState({ data: null, error: null, loading: false })
			return
		}
		let live = true
		setState((current) => ({ ...current, loading: true, error: null }))
		void client
			.request(path)
			.then((body) => {
				const parsed = schemaRef.current.safeParse(body)
				if (!live) return
				if (!parsed.success) {
					setState({
						data: null,
						error: new RegionError(502, 'malformed_response'),
						loading: false,
					})
					return
				}
				setState({ data: parsed.data, error: null, loading: false })
			})
			.catch((error: unknown) => {
				if (!live) return
				setState((current) => ({
					data: current.data,
					error: error instanceof Error ? error : new Error(String(error)),
					loading: false,
				}))
			})
		return () => {
			live = false
		}
	}, [client, path, attempt])

	const reload = useCallback(() => setAttempt((count) => count + 1), [])
	return { ...state, reload }
}
