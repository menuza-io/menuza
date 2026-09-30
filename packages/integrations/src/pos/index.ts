/**
 * POS and delivery-platform integrations (Clover, Square, Toast, Uber Eats,
 * DoorDash). Canonical types, provider payload codecs, adapters and provider
 * classes live here; `./sandbox` holds the MSW sandbox and is intentionally not
 * re-exported (it is dev/test-only).
 */

export * from './types.ts'
export * from './credentials.ts'
export * from './errors.ts'
export * from './adapter.ts'
export * from './transport.ts'
export * from './snapshot.ts'
export * from './project.ts'
export * from './service.ts'
export { isPosSandboxConnectAllowed } from './sandbox-policy.ts'
export { isDoorDashStoreVerified } from './doordash-connect.ts'
export {
	cloverWire,
	squareWire,
	toastWire,
	uberWire,
	doordashWire,
	type Decoded,
} from './wire.ts'
export * from './providers/index.ts'
