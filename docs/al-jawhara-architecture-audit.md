# Al-Jawhara — Architecture Audit & Restructuring Report

## 1. Executive Summary
Al-Jawhara is currently a pnpm monorepo containing a Vite storefront (`artifacts/vibe-app`), an Express API (`artifacts/api-server`), generated client/spec packages (`lib/api-client-react`, `lib/api-zod`, `lib/api-spec`), and a Drizzle PostgreSQL schema package (`lib/db`). The actual architecture is a partial layered monorepo, not Clean Architecture, not FSD, and not a true modular monolith: route handlers own validation, orchestration, persistence, and response DTOs in the same files, while storefront pages and contexts own business rules and direct HTTP calls. The highest-risk findings are order creation without a transaction, N+1 order item loading, client-authoritative money/order totals, route-level type assertions instead of Zod boundary validation, insecure JWT development fallback, and an authorization hole in notification read updates. DESIGN_LOCK remains absolute: all UI, CSS, Tailwind, visual assets, and component markup stay frozen; the migration touches only logic, data, state, API, types, configuration, folder contracts, and dead-code documentation. The target architecture is a Hybrid: FSD on the storefront for feature boundaries plus Modular Monolith/Clean ports on the API and data layer.

## 2. Repository Health Score

| Dimension | Score /10 | One-Line Justification |
|---|---:|---|
| Separation of Concerns | 4 | Express routes mix validation, business rules, persistence, and DTO construction, e.g. order creation in `artifacts/api-server/src/routes/orders.ts:37-91`. |
| Scalability Potential | 4 | High-read catalog endpoints are mock arrays and do not use DB/cache despite Drizzle product tables existing, e.g. `artifacts/api-server/src/routes/products.ts:5-222` versus `lib/db/src/schema/products.ts:3-19`. |
| Testability | 3 | There are no test files in the repository tree, and route logic has no injectable services or repository interfaces. |
| Maintainability | 4 | God pages/components exist in storefront: `ProductDetailPage.tsx` is 640 lines, `AccountSheet.tsx` is 637 lines, `SearchPage.tsx` is 494 lines, and `CheckoutPage.tsx` is 442 lines. |
| Security Posture | 4 | JWT fallback, route body casts, missing ownership predicate in notification update, and client-authoritative totals are present. |
| Developer Experience | 6 | pnpm workspace, TS project references, generated clients, and typecheck scripts exist in root config, but generated clients cover only a subset of API usage. |
| Deployment Readiness | 5 | API build/typecheck exists, but environment access is scattered and CORS can silently accept an empty production allowlist. |
| Type Safety | 5 | Drizzle and generated API packages help, but many API boundaries cast `req.body` and client fetches cast JSON manually. |

**OVERALL FITNESS: 4.4 / 10**

This score means the project can keep shipping small features, but every new domain behavior will compound current coupling unless the API routes are split into controllers/application services/repositories and the storefront moves business logic from pages/contexts into feature models. The repository is not rewrite-worthy; it is migration-worthy, because the visual layer is valuable and frozen, the workspace boundaries already exist, and the dangerous changes can be performed behind stable route/client contracts.

## 3. Critical Issues — Fix Before Anything Else

### [CRITICAL] Order creation is not atomic and accepts client-authoritative totals
- **Evidence:** `artifacts/api-server/src/routes/orders.ts:37-69` inserts the order from `req.body`, including `subtotal`, `shipping`, and `total`; `artifacts/api-server/src/routes/orders.ts:71-82` inserts items separately; `artifacts/api-server/src/routes/orders.ts:84-89` awards points in a swallowed best-effort block.
- **Impact:** order rows can exist without items; totals can be tampered with by clients; loyalty points can drift silently.
- **Do this:** introduce `OrderService.createOrder()` with one transaction; compute prices from `productsTable`; reject mismatches.
```ts
// artifacts/api-server/src/modules/orders/application/create-order.service.ts
export async function createOrder(input: CreateOrderInput, userId: number) {
  return db.transaction(async (tx) => {
    const products = await productRepo.findByIds(tx, input.items.map(i => i.productId));
    const totals = calculateOrderTotals(input.items, products);
    const order = await orderRepo.insert(tx, userId, input.address, totals, input.paymentMethod);
    await orderRepo.insertItems(tx, order.id, buildOrderItems(input.items, products));
    await userRepo.incrementPoints(tx, userId, 10);
    return { orderId: formatOrderId(order.id), total: totals.total };
  });
}
```

### [CRITICAL] N+1 query in order listing
- **Evidence:** `artifacts/api-server/src/routes/orders.ts:16-20` loads orders, then `artifacts/api-server/src/routes/orders.ts:22-30` executes one item query per order.
- **Impact:** p95 latency grows linearly with a user's order count.
- **Do this:** fetch items with `inArray(orderItemsTable.order_id, ids)` and group in memory.
```ts
const orders = await orderRepo.findByUser(userId);
const items = await orderItemRepo.findByOrderIds(orders.map(o => o.id));
return attachItems(orders, items);
```

### [CRITICAL] Notification read endpoint lacks ownership/global predicate
- **Evidence:** `artifacts/api-server/src/routes/notifications.ts:33-41` updates by notification id only; it does not include `user_id = current user OR user_id IS NULL`.
- **Impact:** any authenticated user can mark another user's notification as read by id.
- **Do this:** add user ownership to the `where` clause.
```ts
.where(and(
  eq(notificationsTable.id, id),
  or(eq(notificationsTable.user_id, userId), isNull(notificationsTable.user_id)),
));
```

### [CRITICAL] JWT secret has an insecure development fallback
- **Evidence:** `artifacts/api-server/src/middlewares/auth.ts:4-10` warns and then exports a static fallback secret.
- **Impact:** any non-production deployment accidentally missing `JWT_SECRET` signs predictable tokens.
- **Do this:** move env parsing to `server/shared/config/env.ts` and fail fast in every environment except explicit local test.
```ts
const envSchema = z.object({ JWT_SECRET: z.string().min(32), DATABASE_URL: z.string().url() });
export const env = envSchema.parse(process.env);
```

### [CRITICAL] API input validation is inconsistent and mostly cast-based
- **Evidence:** register casts `req.body` at `artifacts/api-server/src/routes/auth.ts:14`, cart casts `req.body` at `artifacts/api-server/src/routes/cart.ts:43-45`, price alerts cast `req.body` at `artifacts/api-server/src/routes/price-alerts.ts:27-31`, and addresses cast `req.body` at `artifacts/api-server/src/routes/addresses.ts:26-29`.
- **Impact:** malformed payloads reach DB/business logic; runtime behavior diverges from generated types.
- **Do this:** introduce `validateBody(schema)` middleware and route schemas in `lib/api-zod`.
```ts
router.post('/orders', authMiddleware, validateBody(CreateOrderRequest), async (req, res) => {
  const result = await createOrder(req.validatedBody, req.user.userId);
  res.status(201).json(result);
});
```

## 4. Deletion Manifest — Complete File List

| File Path | Tier | Reason for Deletion | Safe to Delete? |
|---|---|---|---|
| `artifacts/vibe-app/upload-categories.mjs` | Tier 1 | One-off Supabase upload script, not referenced by any package script; contains console output and service-role env usage. Evidence: package scripts lack it in `artifacts/vibe-app/package.json:6-10`; script reads `SUPABASE_SERVICE_ROLE_KEY` in `artifacts/vibe-app/upload-categories.mjs:8-9`. | Yes, after confirming no external runbook depends on it. |
| `artifacts/vibe-app/src/lib/designTokens.ts` | Tier 2 | Exported visual token module has no import references in `artifacts/vibe-app/src`; DESIGN_LOCK makes deletion a product/design confirmation item, not an immediate code cleanup. Evidence: token exports start at `artifacts/vibe-app/src/lib/designTokens.ts:10-98`. | No until design owner confirms. |
| `artifacts/api-server/src/routes/brands.ts` mock payload block | Tier 2 | Duplicates DB-owned `brandsTable`; endpoint returns hardcoded data. Evidence: mock array in `artifacts/api-server/src/routes/brands.ts:5-14`; DB schema in `lib/db/src/schema/brands.ts:13-17`. | Delete only after replacing route implementation with repository-backed query. |
| `artifacts/api-server/src/routes/categories.ts` mock payload block | Tier 2 | Duplicates DB-owned `categoriesTable`; endpoint returns hardcoded data. Evidence: mock array in `artifacts/api-server/src/routes/categories.ts:5-15`; DB schema in `lib/db/src/schema/categories.ts:3-8`. | Delete only after replacing route implementation with repository-backed query. |
| `artifacts/api-server/src/routes/products.ts` mock product catalog | Tier 2 | Duplicates DB-owned `productsTable`; current product API ignores DB. Evidence: mock catalog starts at `artifacts/api-server/src/routes/products.ts:5`; DB schema in `lib/db/src/schema/products.ts:3-19`. | Delete only after seeded DB/catalog repository is live. |
| `artifacts/mockup-sandbox/src/components/mockups/ring/V1.tsx` | Tier 2 | Mockup/design artifact dynamically referenced only by generated preview map. Evidence: `artifacts/mockup-sandbox/src/.generated/mockup-components.ts:4`. DESIGN_LOCK blocks unilateral deletion. | No, design confirmation required. |
| `artifacts/mockup-sandbox/src/components/mockups/ring/V2.tsx` | Tier 2 | Mockup/design artifact dynamically referenced only by generated preview map. Evidence: `artifacts/mockup-sandbox/src/.generated/mockup-components.ts:5`. DESIGN_LOCK blocks unilateral deletion. | No, design confirmation required. |
| `artifacts/mockup-sandbox/src/components/mockups/ring/V3.tsx` | Tier 2 | Mockup/design artifact dynamically referenced only by generated preview map. Evidence: `artifacts/mockup-sandbox/src/.generated/mockup-components.ts:6`. DESIGN_LOCK blocks unilateral deletion. | No, design confirmation required. |

**Immediate deletion verdict:** no source file is deleted in this audit because DESIGN_LOCK protects design artifacts and backend mock data must first be replaced by repository-backed reads to avoid behavior regression.

## 5. Root Cause Analysis

### Decision 1: Route handlers are the application layer
- **Decision:** Express route files became controllers, validators, use cases, repositories, and DTO mappers simultaneously.
- **Damage:** Transaction boundaries are absent, validation is ad hoc, and handlers cannot be unit-tested without HTTP/DB.
- **Evidence:** `artifacts/api-server/src/routes/orders.ts:37-91`, `artifacts/api-server/src/routes/price-alerts.ts:24-65`, `artifacts/api-server/src/routes/addresses.ts:23-57`.
- **Correct path:** Use thin route handlers plus application services plus repository interfaces.

### Decision 2: Storefront pages own data-fetching and domain rules
- **Decision:** React pages/components directly perform fetches, localStorage reads, mutations, validation, and analytics-like recent-view logic.
- **Damage:** UI cannot be frozen independently from business logic, and generated clients are bypassed.
- **Evidence:** `artifacts/vibe-app/src/pages/ProductDetailPage.tsx:35-61`, `artifacts/vibe-app/src/pages/SearchPage.tsx:161-180`, `artifacts/vibe-app/src/pages/CheckoutPage.tsx:186-247`.
- **Correct path:** Keep JSX frozen; extract hooks/models under `features/*/model` and HTTP adapters under `features/*/api`.

### Decision 3: API contract generation is partial
- **Decision:** OpenAPI/spec and generated clients exist, but manual fetch wrappers remain dominant.
- **Damage:** Endpoint payloads drift from routes; Zod generated schemas cover only a subset of routes.
- **Evidence:** OpenAPI declares many tags at `lib/api-spec/openapi.yaml:11-25`, generated Zod only covers health/products/brands at `lib/api-zod/src/generated/api.ts:10-45`, while frontend calls manual routes in `artifacts/vibe-app/src/lib/apiFetch.ts:23-58`.
- **Correct path:** Make OpenAPI/Zod the source of truth for every route request and response, then ban raw fetch outside adapters.

### Decision 4: Catalog data stayed as mocks after DB schema was added
- **Decision:** products/brands/categories routes retained in-memory arrays while Drizzle tables exist.
- **Damage:** no DB indexes/query plans/cache policy can improve current catalog routes; seed/source of truth is ambiguous.
- **Evidence:** `artifacts/api-server/src/routes/products.ts:5-222`, `artifacts/api-server/src/routes/brands.ts:5-14`, `artifacts/api-server/src/routes/categories.ts:5-15`, `lib/db/src/schema/products.ts:3-19`.
- **Correct path:** Move catalog to DB repository, seed data explicitly, and cache high-read queries.

### Decision 5: Environment configuration is accessed directly by consumers
- **Decision:** modules read `process.env` inline.
- **Damage:** missing variables fail late or produce insecure fallbacks.
- **Evidence:** `artifacts/api-server/src/app.ts:29-37`, `artifacts/api-server/src/middlewares/auth.ts:4-10`, `lib/db/src/index.ts:7-13`, `artifacts/api-server/src/routes/oauth.ts:116-118`.
- **Correct path:** one Zod-validated `env` module per runtime; no direct `process.env` outside config.

## 6. Target Architecture Overview

**Selected pattern: D — Hybrid.** Use Feature-Sliced Design for `artifacts/vibe-app/src` because the storefront is feature-heavy and UI must remain frozen while logic moves behind stable hooks. Use Modular Monolith + Clean Architecture ports on `artifacts/api-server/src` because Express routes already represent deployable API boundaries and Drizzle schemas already sit in a separate package.

Rejected patterns:
- **Pure FSD only:** weak for server transaction boundaries and repository ports.
- **Pure Clean Architecture only:** too abstract for a UI-heavy Vite storefront and would trigger unnecessary visual churn.
- **Classic layered architecture:** this is what the code approximates now, and it has already failed to enforce boundaries.

10x traffic path: add Redis-backed cache adapters for catalog/search/brands/categories, batch order item reads, and add DB indexes listed below. 3x team path: module contracts prevent feature teams from editing each other's schema/UI internals.

Non-negotiable rules:
1. No `fetch()` outside `features/*/api`, `shared/api`, or generated client packages.
2. No `db` import outside `server/modules/*/infrastructure` or `lib/db`.
3. No `process.env` outside runtime config modules.

## 7. Complete New Directory Structure

```txt
artifacts/vibe-app/src/
├── app/                         # Composition only: providers, router, app bootstrap; maps current App.tsx/main.tsx.
├── pages/                       # FROZEN route-level visual shells; keep JSX/className/style unchanged.
├── widgets/                     # FROZEN composed visual sections migrated from src/components when safe.
├── features/
│   ├── auth/                    # Login/register/reset model and API adapters from AuthContext/AccountSheet logic.
│   │   ├── api/                 # authApi.ts wrapping generated client/apiFetch.
│   │   ├── model/               # auth.store.ts, useAuthSession.ts.
│   │   └── index.ts             # public exports only.
│   ├── cart/                    # Cart state, coupon validation, sync adapters from CartContext.
│   ├── checkout/                # checkout schemas, submit orchestration, totals model.
│   ├── catalog/                 # product/brand/category queries and search params.
│   ├── wishlist/                # wishlist state and API adapters.
│   ├── price-alerts/            # price alert query/mutation model.
│   └── profile/                 # addresses, profile edit, notifications/orders views.
├── entities/
│   ├── product/                 # Product type aliases and pure derived selectors.
│   ├── order/                   # Order DTOs and pure formatting.
│   ├── user/                    # AuthUser type and user selectors.
│   └── address/                 # Address DTOs and validation contracts.
└── shared/
    ├── ui/                      # FROZEN design components; maps current components/ui.
    ├── api/                     # apiFetch/custom generated client setup only.
    ├── lib/                     # Pure utilities: deviceId, shippingPolicy, queryKeys, errors.
    ├── config/                  # Client config/env constants.
    └── types/                   # Cross-feature TS types.

artifacts/api-server/src/
├── app.ts                       # Express composition only.
├── index.ts                     # Runtime entry only.
├── shared/
│   ├── config/env.ts            # Zod env schema; sole process.env consumer.
│   ├── errors/                  # AppError hierarchy and error mapper.
│   ├── http/                    # validateBody, asyncHandler, request context.
│   ├── auth/                    # JWT/session/RBAC middleware.
│   └── observability/           # logger, request id, health telemetry.
├── modules/
│   ├── auth/
│   │   ├── presentation/auth.routes.ts
│   │   ├── application/auth.service.ts
│   │   ├── domain/auth.schemas.ts
│   │   └── infrastructure/user.repository.drizzle.ts
│   ├── catalog/
│   │   ├── presentation/catalog.routes.ts
│   │   ├── application/catalog.service.ts
│   │   ├── domain/catalog.types.ts
│   │   └── infrastructure/catalog.repository.drizzle.ts
│   ├── cart/
│   ├── wishlist/
│   ├── orders/
│   ├── notifications/
│   ├── reviews/
│   ├── addresses/
│   └── price-alerts/
└── routes/index.ts              # Temporary compatibility router during migration only.

lib/db/src/
├── schema/                      # Drizzle schema only.
├── migrations/                  # Future generated SQL migrations only.
└── index.ts                     # DB connection export; no business logic.
```

Strict import rule: `presentation -> application -> domain`; `infrastructure -> domain`; `application` depends on repository interfaces, not Drizzle implementations; frontend `pages/widgets` may import `features` public APIs but features must not import pages/widgets.

## 8. Module Contracts

### MODULE: auth
- **EXPORTS:** `useAuthSession`, `login`, `register`, `resetPassword`, `changePassword`, `AuthUser`, server `AuthService`.
- **IMPORTS:** shared API/config/errors; user repository interface.
- **OWNS:** token/session lifecycle, password hashing/reset rules, OAuth account linking.
- **FORBIDDEN:** cart/wishlist/order internals; UI components except frozen shells consume its hooks.
- **SIDE EFFECTS:** token storage only in auth model; JWT signing only in server auth service.

### MODULE: catalog
- **EXPORTS:** `useProducts`, `useProduct`, `useBrands`, `useCategories`, `CatalogRepository`.
- **IMPORTS:** generated API client, Redis cache port, product/brand/category DB tables.
- **OWNS:** product search/filter/sort, brand/category reads.
- **FORBIDDEN:** cart/wishlist mutations and checkout totals.
- **SIDE EFFECTS:** cache read/write in infrastructure only.

### MODULE: cart
- **EXPORTS:** `useCart`, `CartItem`, `MAX_QTY`, `addToCart`, `removeFromCart`, `applyCoupon`.
- **IMPORTS:** product entity type, cart API adapter, coupon API adapter.
- **OWNS:** local optimistic cart state and server sync.
- **FORBIDDEN:** computing order totals for final charge; final totals belong to orders service.
- **SIDE EFFECTS:** localStorage and toast remain isolated in model/adapters; UI markup unchanged.

### MODULE: checkout/orders
- **EXPORTS:** `CreateOrderRequest`, `OrderSummary`, `createOrder`, `useSubmitOrder`.
- **IMPORTS:** cart public contract, address contract, order repository.
- **OWNS:** transaction boundary, money calculation, order id formatting, loyalty point award.
- **FORBIDDEN:** trusting client totals or product names/prices.
- **SIDE EFFECTS:** DB writes in one transaction; post-commit notifications/events only after successful commit.

### MODULE: notifications
- **EXPORTS:** `useNotifications`, `markNotificationRead`, `NotificationRepository`.
- **IMPORTS:** auth user id, notification table.
- **OWNS:** notification read/visibility rules.
- **FORBIDDEN:** updating rows without user/global predicate.
- **SIDE EFFECTS:** notification inserts from other modules through application port only.

## 9. Data Layer Specification

Repository split example:
```ts
// modules/orders/domain/order.repository.ts
export interface OrderRepository {
  findByUser(userId: number): Promise<Order[]>;
  findItemsByOrderIds(orderIds: number[]): Promise<OrderItem[]>;
  create(input: PersistOrderInput, tx: DbTx): Promise<Order>;
}
```

Transaction rules:
- One transaction for `createOrder`: validate inventory/prices, insert order, insert items, increment points, enqueue notification.
- One transaction for address default changes: unset previous default and set new default together. Current separate writes are visible in `artifacts/api-server/src/routes/addresses.ts:39-55` and `artifacts/api-server/src/routes/addresses.ts:133-134`.
- One transaction for price-alert replacement plus confirmation notification. Current separate delete/insert/notification writes are in `artifacts/api-server/src/routes/price-alerts.ts:42-63`.

Caching strategy:
- Redis `catalog:products:list:{queryHash}` TTL 60s; invalidate on product mutation/import.
- Redis `catalog:product:{id}` TTL 5m; invalidate on product update/stock/price change.
- Redis `catalog:brands` TTL 1h and `catalog:categories` TTL 1h; invalidate on admin edits.
- Redis `reviews:product:{productId}` TTL 60s; invalidate on review insert.
- Do not cache user carts, auth/session data, or checkout totals.

N+1 fix:
```ts
const ids = orders.map(o => o.id);
const items = ids.length ? await db.select().from(orderItemsTable).where(inArray(orderItemsTable.order_id, ids)) : [];
```

Prisma/Drizzle schema improvements:
- Add indexes on `orders.user_id`, `orders.created_at`, and composite `(user_id, created_at)` for `artifacts/api-server/src/routes/orders.ts:16-20`.
- Add index on `order_items.order_id` for `artifacts/api-server/src/routes/orders.ts:24-27`.
- Add composite unique/index `(device_id, product_id, color)` for cart checks in `artifacts/api-server/src/routes/cart.ts:50-57`.
- Add composite unique/index `(device_id, product_id)` for wishlist checks in `artifacts/api-server/src/routes/wishlist.ts:46-50`.
- Add composite unique/index `(user_id, product_id)` for price alerts in `artifacts/api-server/src/routes/price-alerts.ts:42-45`.
- Add composite unique/index `(product_id, user_id)` for review duplicate checks in `artifacts/api-server/src/routes/reviews.ts:43-50`.

## 10. Cross-Cutting Infrastructure Design

### Error handling
```ts
export class AppError extends Error { constructor(public code: string, public status: number, message: string, public expose = true) { super(message); } }
export class ValidationError extends AppError { constructor(message = 'Invalid request') { super('VALIDATION_ERROR', 400, message); } }
export class UnauthorizedError extends AppError { constructor() { super('UNAUTHORIZED', 401, 'غير مصرح'); } }
```
Propagation rule: domain throws typed errors, application maps to app errors, presentation serializes client-safe messages, logger receives server-only context.

### Validation
All API bodies/params/query strings use Zod at the route boundary. Frontend schemas may be reused for immediate UX only; server remains authoritative. `CheckoutPage.tsx` currently validates address/card in UI at `artifacts/vibe-app/src/pages/CheckoutPage.tsx:15-22` and `artifacts/vibe-app/src/pages/CheckoutPage.tsx:186-207`; keep UX validation but duplicate no business authority there.

### Authentication & authorization
Middleware chain: `requestId -> pinoHttp -> cors -> bodyParser -> rateLimit -> authOptional/authRequired -> validate -> handler -> errorHandler`. RBAC shape:
```ts
export type Role = 'customer' | 'support' | 'admin';
export const can = { notifications: { markRead: (u, n) => n.userId === u.id || n.userId === null } };
```
Session/JWT: signed access token 15m + httpOnly refresh token 30d for production; current localStorage token can remain during transition behind `authApi` contract.

### Observability
Structured log fields: `requestId`, `userId`, `route`, `method`, `statusCode`, `durationMs`, `feature`, `errorCode`. Trace catalog cache hit/miss, checkout transaction id, OAuth provider result, and rate-limit denials. Health endpoint returns dependency status, not only static status; current health router is static and only mounted through `artifacts/api-server/src/routes/index.ts:20`.

### Environment configuration
Only `shared/config/env.ts` can read `process.env`. Required: `DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGIN`; optional: `LOG_LEVEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`.

## 11. Zero-Regression Migration Roadmap

| Phase | Name | Objective | Files | Prerequisite | Test Gate | Rollback | Effort |
|---|---|---|---|---|---|---|---|
| 1 | Execute deletion manifest Tier 1 | Remove confirmed one-off/dead non-design files only. | Delete `artifacts/vibe-app/upload-categories.mjs` after confirmation. | Confirm no runbook/script uses it. | `pnpm run typecheck` passes. | Restore file from previous commit. | S |
| 2 | Establish skeleton | Add folders/config without moving UI. | Create `artifacts/api-server/src/shared/*`, `artifacts/api-server/src/modules/*`, `artifacts/vibe-app/src/features/*`, `artifacts/vibe-app/src/entities/*`. | Phase 1. | `pnpm run typecheck` passes. | Remove empty skeleton commit. | S |
| 3 | Extract business logic from UI | Move hooks/functions only; preserve JSX/className/style. | Extract from `CartContext.tsx`, `AuthContext.tsx`, `SearchPage.tsx`, `CheckoutPage.tsx`, `ProductDetailPage.tsx`. | Skeleton. | Typecheck + manual route smoke. | Revert extraction commit. | L |
| 4 | Implement repository pattern | Add repo interfaces/Drizzle implementations. | Add `modules/*/domain/*.repository.ts`, `modules/*/infrastructure/*.drizzle.ts`. | Extracted service contracts. | Typecheck + API smoke. | Switch routes back to old handlers. | L |
| 5 | Migrate features | One feature at a time behind public index files. | `features/auth`, `features/cart`, `features/catalog`, `features/checkout`, `features/profile`. | Repo layer. | Feature-specific smoke + typecheck. | Revert feature commit only. | XL |
| 6 | Cross-cutting infra | Centralize env/errors/validation/auth/logging. | `shared/config/env.ts`, `shared/errors`, `shared/http/validate.ts`, `shared/auth`. | Module migration stable. | Missing env fails fast in test; typecheck passes. | Restore previous middleware. | M |
| 7 | Performance/security hardening | Batch queries, add indexes, cache high-read queries, ownership fixes. | `orders`, `notifications`, schema indexes, cache adapter. | Infra in place. | API smoke + DB migration check. | Revert index/cache route commit. | L |
| 8 | Developer tooling/DX | Enforce boundaries. | ESLint/dep rules, scripts, codegen coverage. | Stable target layout. | Boundary lint passes. | Disable new lint rule. | M |

## 12. Quick Wins — 10 Immediate Actions

1. **FILE:** `artifacts/api-server/src/routes/notifications.ts` — **CHANGE:** add user/global ownership predicate to read update. **BENEFIT:** closes cross-user write bug. **RISK:** none.
2. **FILE:** `artifacts/api-server/src/routes/orders.ts` — **CHANGE:** batch order items instead of per-order queries. **BENEFIT:** removes N+1 latency. **RISK:** low.
3. **FILE:** `artifacts/api-server/src/routes/orders.ts` — **CHANGE:** wrap order insert + items + points in transaction. **BENEFIT:** prevents partial orders. **RISK:** low.
4. **FILE:** `artifacts/api-server/src/middlewares/auth.ts` — **CHANGE:** replace static fallback with validated env. **BENEFIT:** prevents predictable tokens. **RISK:** requires local `.env`.
5. **FILE:** `artifacts/api-server/src/routes/cart.ts` — **CHANGE:** validate body with Zod schema. **BENEFIT:** rejects malformed qty/product payloads. **RISK:** low.
6. **FILE:** `artifacts/api-server/src/routes/price-alerts.ts` — **CHANGE:** validate positive numeric product/current/target prices. **BENEFIT:** prevents invalid alerts. **RISK:** low.
7. **FILE:** `lib/api-spec/openapi.yaml` — **CHANGE:** regenerate clients for all implemented routes. **BENEFIT:** removes manual type drift. **RISK:** medium generated diff.
8. **FILE:** `lib/db/src/schema/orders.ts` — **CHANGE:** add indexes for order/user and item/order lookups. **BENEFIT:** improves order history reads. **RISK:** migration required.
9. **FILE:** `artifacts/api-server/src/routes/brands.ts` — **CHANGE:** replace mockBrands with repository DB read. **BENEFIT:** one catalog source of truth. **RISK:** needs seed data.
10. **FILE:** `artifacts/vibe-app/src/context/CartContext.tsx` — **CHANGE:** move API functions lines 52-78 into `features/cart/api/cartApi.ts` without changing provider rendering. **BENEFIT:** isolates side effects. **RISK:** low.

## 13. Architecture Decision Records

### ADR-1: Hybrid FSD + Modular Monolith/Clean Ports
STATUS: Proposed. CONTEXT: UI must remain frozen while server logic must gain transactional boundaries. DECISION: FSD for storefront logic, modular monolith with Clean ports for API modules. RATIONALE: matches current Vite/Express/workspace split. CONSEQUENCES: positive — team-scale boundaries; negative — initial folder and import discipline cost. REVIEW DATE: 2026-11-16.

### ADR-2: Server-owned Money and Order Totals
STATUS: Proposed. CONTEXT: client currently sends monetary totals. DECISION: server computes all final totals from DB product prices and coupon policy. RATIONALE: prevents tampering and reconciliation drift. CONSEQUENCES: positive — trustworthy orders; negative — checkout must tolerate recalculated totals. REVIEW DATE: 2026-11-16.

### ADR-3: Zod at Every API Boundary
STATUS: Proposed. CONTEXT: route handlers cast request bodies. DECISION: every route defines body/params/query schemas and receives parsed values only. RATIONALE: runtime validation must match TS contracts. CONSEQUENCES: positive — fewer production type holes; negative — schema maintenance. REVIEW DATE: 2026-11-16.

### ADR-4: Repository Interfaces for Drizzle Access
STATUS: Proposed. CONTEXT: route handlers import `db` directly. DECISION: only infrastructure repositories import Drizzle tables and `db`. RATIONALE: enables service tests and future cache/transaction adapters. CONSEQUENCES: positive — testability; negative — more files per module. REVIEW DATE: 2026-11-16.

### ADR-5: Centralized Runtime Environment Contract
STATUS: Proposed. CONTEXT: env access and fallback secrets are scattered. DECISION: one validated env module per runtime, no raw `process.env` elsewhere. RATIONALE: fail fast beats insecure defaults. CONSEQUENCES: positive — deployment safety; negative — local setup must define required vars. REVIEW DATE: 2026-11-16.

## 14. 12-Month Evolution Path

- **Months 0-2:** Complete quick wins, transaction/order fixes, notification authorization fix, Zod route boundary, generated client coverage.
- **Months 3-4:** Replace mock catalog routes with DB repositories and Redis cache; seed catalog tables; add schema indexes.
- **Months 5-6:** Complete storefront feature-model extraction without changing visual layer; ban direct fetch via lint.
- **Months 7-9:** Add RBAC/admin module, structured audit logs, health dependency checks, and payment provider abstraction.
- **Months 10-12:** Split high-load catalog read model if needed, add queue-based notification/price-alert processing, and evaluate moving API modules to NestJS only if operational complexity justifies it.

## Audit Command Log
- `pwd && find .. -name AGENTS.md -print`
- `rg --files -g '!node_modules' -g '!.git' -g '!dist' -g '!.next' -g '!coverage' | sort`
- `cat package.json; cat tsconfig.json; cat pnpm-workspace.yaml; find artifacts lib -maxdepth 3 -name package.json -print -exec sed -n '1,220p' {} \;`
- `python3` line-count/import-reference scripts for source inventory.
- `rg -n "console\.|debugger" -g '!node_modules' -g '!dist' -g '!.next' .`
- `rg -n "\b(any|unknown)\b" artifacts/api-server lib artifacts/vibe-app/src -g '*.ts' -g '*.tsx'`
- `rg -n "\bfetch\(" artifacts/vibe-app/src -g '*.tsx' -g '*.ts'`
- `rg -n "process\.env" artifacts lib -g '*.ts' -g '*.mjs'`
- Targeted `nl -ba` inspections of all cited files.
