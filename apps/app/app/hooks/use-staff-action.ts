import { type MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react'
import { useCallback, useRef, useState } from 'react'
import {
	describeStaffError,
	fieldIssues,
} from '#app/utils/staffing/staff-errors.ts'

type DescribeError = (
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
) => string

export type ActionResult<T> = { ok: true; value: T } | { ok: false }

/**
 * Pending, error and field-issue state for one staff write. `run` returns a
 * result instead of throwing, ignores a second call while one is in flight, and
 * writes a plain-language message for the manager (never the raw server text).
 */
export function useStaffAction(describe: DescribeError = describeStaffError) {
	const { _ } = useLingui()
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [issues, setIssues] = useState<Record<string, string>>({})
	const busy = useRef(false)

	const run = useCallback(
		async <T>(work: () => Promise<T>): Promise<ActionResult<T>> => {
			if (busy.current) return { ok: false }
			busy.current = true
			setPending(true)
			setError(null)
			setIssues({})
			try {
				return { ok: true, value: await work() }
			} catch (failure) {
				setError(describe(failure, _))
				setIssues(fieldIssues(failure))
				return { ok: false }
			} finally {
				busy.current = false
				setPending(false)
			}
		},
		[_, describe],
	)

	const reset = useCallback(() => {
		setError(null)
		setIssues({})
	}, [])

	return { pending, error, issues, run, reset }
}
