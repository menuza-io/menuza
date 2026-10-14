import { useEffect, useMemo, useState } from 'react'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import {
	staffListSchema,
	type StaffListRow,
} from '#app/utils/staffing/staff-types.ts'

const PAGE = 200
/** Five pages is a thousand people: more than one regional roster screen is meant for. */
const MAX_PAGES = 5

export type StaffDirectory = {
	people: StaffListRow[] | null
	failed: boolean
	/** A person's name, or an empty string before the roster loads or for someone not on it. */
	nameOf: (staffId: string) => string
	byId: ReadonlyMap<string, StaffListRow>
}

/**
 * The roster as names, for screens whose own data names people only by id
 * (time-off and availability lists). It reads the staff scope's list in pages
 * and never stores anything: names stay in this tab's memory.
 */
export function useStaffDirectory(
	client: StaffClient,
	ready: boolean,
	locale: string,
): StaffDirectory {
	const [state, setState] = useState<{
		people: StaffListRow[] | null
		failed: boolean
	}>({
		people: null,
		failed: false,
	})
	useEffect(() => {
		if (!ready) return
		let live = true
		void (async () => {
			try {
				const all: StaffListRow[] = []
				for (let page = 0; page < MAX_PAGES; page++) {
					const body = staffListSchema.parse(
						await client.request(`/?limit=${PAGE}&offset=${page * PAGE}`),
					)
					all.push(...body.staff)
					if (all.length >= body.total || body.staff.length < PAGE) break
				}
				if (live) setState({ people: all, failed: false })
			} catch {
				if (live) setState({ people: null, failed: true })
			}
		})()
		return () => {
			live = false
		}
	}, [client, ready])

	const byId = useMemo(
		() => new Map((state.people ?? []).map((person) => [person.id, person])),
		[state.people],
	)
	return {
		people: state.people,
		failed: state.failed,
		byId,
		nameOf: (staffId) => {
			const person = byId.get(staffId)
			return person ? staffDisplayName(person, locale) : ''
		},
	}
}
