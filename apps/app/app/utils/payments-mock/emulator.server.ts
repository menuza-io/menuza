import {
	createPaymentsEmulator,
	isPaymentsMockOn,
	mockWebhookSecrets,
	parseMockWebhookMode,
	paymentsMockMode,
	type MockClock,
	type MockStore,
	type PaymentsEmulator,
	type PaymentsMockEnv,
} from '@repo/payments/mock'
import { createSqlMockStore } from './store.server.ts'
import { createWebhookTransport } from './webhook-dispatch.server.ts'

const CLOCK_ROW = { provider: 'mock' as const, id: 'clock', type: 'clock' }

/**
 * Mock time lives in the store (an offset), so `clock/advance` survives App
 * restarts and every isolate sees the same time.
 */
export function createStoreClock(store: MockStore): MockClock {
	let offset = 0
	return {
		now: () => Date.now() + offset,
		async refresh() {
			const row = await store.getObject(CLOCK_ROW.provider, CLOCK_ROW.id)
			offset = Number(row?.json.offsetMs ?? 0)
		},
		async advance(milliseconds) {
			for (let attempt = 0; attempt < 5; attempt++) {
				const row = await store.getObject(CLOCK_ROW.provider, CLOCK_ROW.id)
				const next = Number(row?.json.offsetMs ?? 0) + milliseconds
				if (!row) {
					const now = Date.now()
					const inserted = await store.insertObject({
						...CLOCK_ROW,
						parentId: null,
						json: { offsetMs: next },
						transitionAt: null,
						createdAt: now,
						updatedAt: now,
					})
					if (!inserted) continue
				} else {
					const replaced = await store.replaceObject({
						provider: CLOCK_ROW.provider,
						id: CLOCK_ROW.id,
						json: { offsetMs: next },
						expectedRev: Number(row.json.__rev ?? 0),
						transitionAt: null,
						updatedAt: Date.now(),
					})
					if (!replaced) continue
				}
				offset = next
				return next
			}
			throw new Error('mock clock is contended')
		},
	}
}

export function resolveMockOrigin(env: PaymentsMockEnv = process.env) {
	return (
		env.PAYMENTS_MOCK_ORIGIN?.trim() ||
		env.BASE_URL?.trim() ||
		'http://localhost:3001'
	).replace(/\/$/, '')
}

let emulator: PaymentsEmulator | null = null

/** The process-wide emulator on the control-plane database. */
export function getPaymentsEmulator(env: PaymentsMockEnv = process.env) {
	if (!emulator) {
		const store = createSqlMockStore()
		emulator = createPaymentsEmulator({
			store,
			clock: createStoreClock(store),
			origin: resolveMockOrigin(env),
			secrets: mockWebhookSecrets(env),
			// Read per event so a changed PAYMENTS_MOCK_WEBHOOKS applies at once.
			webhookMode: () =>
				parseMockWebhookMode(process.env.PAYMENTS_MOCK_WEBHOOKS),
			transport: createWebhookTransport(),
			fidelity: {
				checkoutSessionIdOnWebhooks:
					process.env.PAYMENTS_MOCK_CKO_SESSION_ID === 'true',
			},
		})
	}
	return emulator
}

/** Tests that need a fresh singleton. */
export function resetPaymentsEmulatorSingleton() {
	emulator = null
}

export function logPaymentsMockBoot(env: PaymentsMockEnv = process.env) {
	const mode = paymentsMockMode(env)
	if (!isPaymentsMockOn(mode)) return
	const providers = [
		mode.stripe ? 'stripe' : null,
		mode.checkout ? 'checkout.com' : null,
	].filter(Boolean)
	console.info(`PAYMENTS MOCK ACTIVE (${providers.join(', ')})`)
}
