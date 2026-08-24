# CJ Dropshipping API — verified behavior

Recorded 2026-08-23 by driving a real CJ account (`CJ5754634`) through the full order pipeline.
**CJ's published docs disagree with its own wire format in several places.** Where they conflict,
what is written here — and pinned by the fixtures in `packages/supplier/test/fixtures/cj/` — is
what the API actually does.

## Account setup

- API access is behind an installable app: **Apps → Install App → "API" (under Others) → Add API
  → Type: API Key**. There is no standalone "Authorization" menu any more.
- `CJ_OPEN_ID` is not shown anywhere in the dashboard. It is the account's numeric `openId`,
  readable only by authenticating and calling `GET /setting/get`.

## Field names differ between endpoints for the same concept

| Concept | `product/listV2` | `product/query` |
|---|---|---|
| product id | `id` | `pid` |
| name | `nameEn` | `productNameEn` |
| image | `bigImage` | `productImage` / `productImageSet` |

`listV2` also nests its results two levels deep — `{ content: [{ productList: [...] }] }` — while
every other list endpoint returns a flat `{ list: [...] }`.

## Order identity: three different ids

`createOrderV3` returns the `SD…` code as `orderId`. `order/list` and `getOrderDetail` return an
**internal numeric** `orderId` and put the `SD…` code in `cjOrderId` / `cjOrderCode`.

Everything else (`getOrderDetail`, `confirmOrder`, `simulatePay`) is keyed by the **`SD…` code** —
passing the numeric id fails with "Order not found". `mapOrderAmounts` therefore prefers
`cjOrderId` and falls back to `orderId`.

The client-supplied idempotency key comes back as **`orderNum`** on `order/list`, but as
`orderNumber` on the `createOrderV3` response. Matching on `orderNumber` (as the code originally
did) never matched, which silently defeated idempotency — every retry placed a second chargeable
order.

## createOrderV3 request quirks

- `isSandbox: 1` (integer) is the **only** thing that makes an order a test order. A bare
  `sandbox: true` is ignored, and the order is placed for real. Confirmed by reading `isSandbox`
  back off `getOrderDetail`.
- `platform` is documented as optional ("Default: Api") but is **required**: omitting it fails
  with `5027 Platform null not support`. Every casing of `api` is also rejected — the API is not
  an accepted order-origin platform. We send `shopify`, which is accurate anyway.
- `shopLogisticsType: 1` ("platform shipping mode") additionally demands a `storageId`, pinning
  the order to one warehouse (`5030 Storage ID cannot be empty`). `2` is the documented default
  and lets CJ route.
- Address fields are `shippingCustomerName` / `shippingAddress` / `shippingAddress2` /
  `shippingCity` / `shippingProvince` / `shippingZip` / `shippingPhone` — **not**
  `consigneeName` / `addressLine1` / `city` / `province` / `zip` / `phone`.
- `shippingCountry` (the country's display name) is required alongside `shippingCountryCode`.

## createOrderV3 response quirks

`shipmentOrderId` and `orderAmount` both come back **null** at creation — CJ assigns a shipment id
later, and the total has to be computed as `productAmount + postageAmount`.

## Payment

`payBalanceV2` rejects sandbox orders outright (HTTP 400). Sandbox orders are paid with
`/shopping/sandbox/simulatePay`, which moves them to `UNSHIPPED` exactly as a real payment would.

## Order status enum

`CREATED` → `IN_CART` → `UNPAID` → `UNSHIPPED` → `SHIPPED` → `DELIVERED`, plus `CANCELLED`.
`UNSHIPPED` (paid, not yet shipped) is the one the original mapping table missed. `PENDING` and
`PROCESSING` are not CJ statuses at all — kept only as defensive synonyms.

State transitions are enforced: an unpaid order cannot be advanced ("current status CREATED(100)
can only be updated to none"), and a paid one cannot be re-confirmed.

## Disputes

Both dispute endpoints require an order that has actually been **paid** — an unpaid one answers
"Order cannot be disputed".

- `disputeProducts` returns line items under `productInfoList` (not `list`), keyed by
  `cjVariantId` (not `vid`), each with a `canChoose` flag. CJ keeps returning the items after the
  dispute window closes and just flips `canChoose` to false, so item presence alone does not mean
  the order is disputable.
- `disputeConfirmInfo` wants `disputeProducts`' `productInfoList` entries **passed straight back
  through**; reshaping them into `{lineItemId, vid}` pairs fails with HTTP 400.
- Its response uses `maxAmount` (not `maxRefundAmount`), `expectResultOptionList` as **strings**
  `["1","2"]` (not ints), and `disputeReasonList` with `{disputeReasonId, reasonName}` (not
  `reasons` with `{reasonId, reasonNameEn}`).

## Misc

- `sellPrice` on `listV2` can be a **range string** (`"15.16 -- 15.17"`) when variants differ in
  price. `usdToCents` rightly rejects it, so the CJ mapper collapses a range to its low end.
- Free tier is 1 rps; the live contract suite takes ~40s because of it.
- Contract-test idempotency keys must be unique per run — orders outlive the run, so a fixed key
  makes the next run reuse an order that has already advanced past the expected state.

## Still unverified

- **Webhook signing.** `verifyWebhook` assumes `base64(hmacSHA256(openId, rawBody))` under one of
  `cj-signature` / `x-cj-signature` / `signature`. No live CJ webhook has been received yet.
- `lastMileTrackNumber` never appeared on the observed sandbox order; presumed carrier-dependent.
- `openDispute` / `getDispute` request bodies — not exercised by the contract suite.
