import { vi } from 'vitest'
import {
	ReservationsApiError,
	type ReservationsRequestOptions,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'

export type ScriptedCall = {
	path: string
	method: string
	body: Record<string, any> | undefined
	query: Record<string, unknown> | undefined
	headers: Record<string, string> | undefined
}

export type ScriptedReply = unknown | ReservationsApiError

/** A request-only client whose answers come from `handler`; it records every call. */
export function createScriptedClient(
	handler: (call: ScriptedCall) => ScriptedReply | Promise<ScriptedReply>,
) {
	const calls: ScriptedCall[] = []
	const request = vi.fn(
		async (path: string, options: ReservationsRequestOptions = {}) => {
			const call: ScriptedCall = {
				path,
				method: options.method ?? 'GET',
				body: options.body as Record<string, any> | undefined,
				query: options.query,
				headers: options.headers,
			}
			calls.push(call)
			const reply = await handler(call)
			if (reply instanceof ReservationsApiError) throw reply
			return reply
		},
	)
	const client = {
		scope: 'guests',
		request,
		requestConditional: vi.fn(),
		getToken: vi.fn(),
		invalidate: vi.fn(),
	} as unknown as ReservationsScopedClient
	return { client, calls, request }
}

export function apiError(status: number, code: string) {
	return new ReservationsApiError(code, status, { error: code })
}
