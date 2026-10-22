/** Round-number cash tenders just above the amount due, nearest first. */
export function quickCashAmounts(dueCents: number): number[] {
	const steps = [100, 500, 1000, 2000, 5000, 10000]
	const out = new Set<number>()
	for (const step of steps) {
		const up = Math.ceil(dueCents / step) * step
		if (up > dueCents) out.add(up)
	}
	return [...out].sort((a, b) => a - b).slice(0, 4)
}
