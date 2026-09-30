/**
 * POS/delivery platform sandbox handlers, owned by `@repo/integrations` so the
 * payloads stay next to the codecs they must satisfy. Re-exported here so the
 * dev server and tests can install them with the rest of the mock server.
 */
export {
	posSandboxHandlers as handlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
