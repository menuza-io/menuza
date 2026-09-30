/** Whether in-process POS sandbox connections are allowed (dev / tests only). */
export function isPosSandboxConnectAllowed(): boolean {
	if (typeof process === 'undefined') return false
	if (process.env.NODE_ENV === 'test') return true
	if (process.env.MOCKS === 'true') return true
	return process.env.NODE_ENV !== 'production'
}
