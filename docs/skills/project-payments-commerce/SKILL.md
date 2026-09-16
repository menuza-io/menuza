---
name: project-payments-commerce
description:
  Guide subscription billing, hosted checkout, tenant shop processors, webhooks,
  fees, idempotency, and order status in this project.
---

# Project payments and commerce

## When to use this skill

Use this skill when changing subscriptions, trials, billing portals, checkout,
tenant shop orders, payment-provider configuration, webhooks, payment status, or
commission/payout logic.

## Two commerce surfaces

- Platform/operator billing uses `@repo/payments` provider abstraction for
  subscriptions, products, prices, trials, customer portals, invoices, and
  webhooks. Its control-plane records belong to App/Admin.
- Tenant shop checkout uses the shop layer in `@repo/payments` and regional
  tenant-api order/customer data. Current shop processor IDs are `connect`,
  `mor` (Polar), and `checkout`; persisted provider values are normalized by
  `processors.ts`.

Keep provider selection behind `createPaymentProvider()` or the shop commerce
client. Do not scatter Stripe/Polar/Checkout.com SDK calls through route
components or duplicate provider-specific status mapping.

## Checkout safety

Create checkout sessions server-side after resolving the organization/product
and, when present, authenticating the customer. Treat `success_url` returns and
client payment IDs as navigation hints only; fetch provider/order status from a
trusted server path before displaying a paid state or granting access.

Use integer minor-unit amounts, explicit currency, bounded metadata, and the
existing shop fee calculation. Persist processor/session/payment/order IDs so a
return request can be reconciled without creating a second order.

Sites shop API routes return `Cache-Control: no-store`. Sites may pass a tenant
Bearer token for signed-in checkout, but customer identity must be derived from
the verified token—not a customer ID in the request body. Guest checkout remains
possible where the existing route permits it.

## Webhooks and idempotency

Verify the provider signature against the raw request body before parsing:

- Stripe uses `stripe-signature` and the configured webhook secret.
- Polar uses its webhook verification helper and signature headers.
- Checkout.com uses the existing HMAC verifier and `cko-signature` header.

Reject missing/invalid signatures before database work. Handle duplicate event
delivery idempotently, persist provider event/IDs when the existing schema
supports it, and make status transitions monotonic and provider-aware. Never
trust a browser redirect to mark an order paid.

Use idempotency keys for provider creates where supported. Record a failure
state and safe diagnostic event instead of retrying a payment creation blindly.
Do not log card data, secrets, full webhook bodies, or unnecessary customer PII.

## Configuration and tests

Read the app/package env schemas for Stripe, Polar, Checkout.com, trial, portal,
and webhook variables. Keep publishable keys separate from secret keys and place
each secret only in the runtime that needs it.

Test processor normalization, fee math, hosted/inline checkout configuration,
signature failures, duplicate webhooks, pending/failed/paid transitions, guest
versus authenticated checkout, and cross-organization order access using the
existing payment and tenant-api fixtures.

## References

- [Payments package guide](../../../packages/payments/README.md)
- [Payment types](../../../packages/payments/src/types.ts)
- [Shop commerce](../../../packages/payments/src/shop/commerce.ts)
- [Payment webhooks](../../../packages/payments/src/route-handlers/stripe-webhook.ts)
- [Tenant shop routes](../../../apps/tenant-api/src/routes/shop.ts)
