// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '#app/components/reservations/scripted-test-client.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { renderStaff } from '#tests/staff-render.tsx'

const created = { reservation: { id: 'rsv-walk', version: 1 }, moveNotices: [] }

function renderDialog(...replies: Array<'network' | 'ok' | number>) {
	let post = 0
	const scripted = createScriptedClient((call) => {
		if (call.method === 'GET') return {}
		const reply = replies[post++] ?? 'ok'
		if (reply === 'ok') return created
		if (reply === 'network') throw new TypeError('Failed to fetch')
		return apiError(reply, reply >= 500 ? 'server_error' : 'rejected')
	})
	renderStaff(
		<WalkInDialog
			open
			onOpenChange={vi.fn()}
			client={scripted.client}
			locationId="loc-1"
			businessDate="2026-10-20"
			tableStates={[]}
			onCreated={vi.fn()}
		/>,
	)
	return scripted
}

const postKeys = (calls: ScriptedCall[]) =>
	calls
		.filter((c) => c.method === 'POST')
		.map((c) => c.headers?.['Idempotency-Key'])

async function submitAndSettle(calls: ScriptedCall[], count: number) {
	fireEvent.click(screen.getByTestId('walk-in-submit-btn'))
	await waitFor(() => expect(postKeys(calls)).toHaveLength(count))
	await waitFor(() =>
		expect(screen.getByTestId('walk-in-submit-btn')).toBeEnabled(),
	)
}

describe('WalkInDialog idempotency key', () => {
	it('keeps the key across a network error and a 5xx', async () => {
		const { calls } = renderDialog('network', 503, 'ok')
		await submitAndSettle(calls, 1)
		await submitAndSettle(calls, 2)
		await submitAndSettle(calls, 3)
		expect(new Set(postKeys(calls)).size).toBe(1)
	})

	it('takes a new key after a definite 4xx rejection', async () => {
		const { calls } = renderDialog(409, 'ok')
		await submitAndSettle(calls, 1)
		await submitAndSettle(calls, 2)
		const [first, second] = postKeys(calls)
		expect(second).not.toBe(first)
	})

	it('takes a new key when the form changed', async () => {
		const { calls } = renderDialog('network', 'ok')
		await submitAndSettle(calls, 1)
		fireEvent.change(screen.getByTestId('walk-in-guest-name'), {
			target: { value: 'Someone Else' },
		})
		await submitAndSettle(calls, 2)
		const [first, second] = postKeys(calls)
		expect(second).not.toBe(first)
	})
})
