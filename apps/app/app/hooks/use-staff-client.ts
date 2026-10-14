import { type StaffingPermission, type StaffingScope } from '@repo/staffing'
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { type z } from 'zod'
import {
	holdsGrant,
	type StaffApiError,
	type StaffClient,
	type StaffClientPool,
} from '#app/utils/staffing/staff-client.ts'

/**
 * The Staff layout creates one client pool for the organization and provides it
 * here, so every Staff screen shares the same cached, auto-refreshing tokens.
 * The pool lives only as long as the layout is mounted, so a token can never
 * outlive a sign-out or an organization switch.
 */
export const StaffClientContext = createContext<StaffClientPool | null>(null)

export function useStaffClient(scope: StaffingScope = 'staff') {
	const pool = useContext(StaffClientContext)
	if (!pool)
		throw new Error('useStaffClient must be used inside the Staff layout')
	const client = useMemo(() => pool.get(scope), [pool, scope])
	const [state, setState] = useState<{
		grants: ReadonlySet<StaffingPermission> | null
		failed: boolean
	}>({ grants: null, failed: false })

	useEffect(() => {
		let live = true
		client.grants().then(
			(grants) => live && setState({ grants, failed: false }),
			() => live && setState({ grants: null, failed: true }),
		)
		return () => {
			live = false
		}
	}, [client])

	const can = useCallback(
		(permission: StaffingPermission) => holdsGrant(state.grants, permission),
		[state.grants],
	)
	return {
		client,
		orgSlug: pool.orgSlug,
		/** Grants the token carries; null until the first mint finishes. */
		grants: state.grants,
		ready: state.grants !== null,
		/** True when no token could be minted at all. */
		unavailable: state.failed,
		can,
	}
}

export type StaffQuery<T> = {
	data: T | null
	error: StaffApiError | Error | null
	/** True until the first response; stays false while refreshing. */
	loading: boolean
	refreshing: boolean
	reload: () => void
}

/**
 * GET a staff resource and parse it. Previous data stays on screen while a new
 * request runs, so filters and reloads never flash an empty list. Pass `null`
 * for `path` to wait (for example until a token or a form value exists).
 */
export function useStaffQuery<S extends z.ZodTypeAny>(
	client: StaffClient,
	path: string | null,
	schema: S,
): StaffQuery<z.infer<S>> {
	const [state, setState] = useState<{
		data: z.infer<S> | null
		error: Error | null
		loading: boolean
		refreshing: boolean
	}>({ data: null, error: null, loading: path !== null, refreshing: false })
	const [tick, setTick] = useState(0)

	useEffect(() => {
		if (path === null) return
		let live = true
		setState((current) => ({
			...current,
			error: null,
			loading: current.data === null,
			refreshing: current.data !== null,
		}))
		client.request(path).then(
			(body) => {
				if (!live) return
				const parsed = schema.safeParse(body)
				if (!parsed.success) {
					setState({
						data: null,
						error: new Error('malformed_response'),
						loading: false,
						refreshing: false,
					})
					return
				}
				setState({
					data: parsed.data,
					error: null,
					loading: false,
					refreshing: false,
				})
			},
			(error: unknown) => {
				if (!live) return
				setState((current) => ({
					...current,
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
	}, [client, path, tick])

	const reload = useCallback(() => setTick((value) => value + 1), [])
	return { ...state, reload }
}
