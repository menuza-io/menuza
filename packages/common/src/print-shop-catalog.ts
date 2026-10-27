import { createPrintCatalog } from './print-shop.ts'

/**
 * The catalog this deployment prints. It is the one place that picks the
 * print vertical's products and QR targets: upstream ships the core alone
 * (`createPrintCatalog()`), and a fork passes its extension here. The App
 * side of a vertical is registered in `apps/app/app/utils/print/vertical.server.ts`
 * and `apps/app/app/components/print/vertical-ui.tsx`.
 */
export const printCatalog = createPrintCatalog()
