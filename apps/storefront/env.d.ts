/// <reference types="vite/client" />
/// <reference types="react-router" />
/// <reference types="@shopify/oxygen-workers-types" />
/// <reference types="@shopify/hydrogen/react-router-types" />

// Enhance TypeScript's built-in typings.
import '@total-typescript/ts-reset';

declare global {
  /**
   * Hydrogen declares `interface Env extends HydrogenEnv {}` globally; this augments it with
   * the storefront's own vars so `context.env.X` typechecks. Both are optional — without them
   * `/contact` renders its "temporarily unavailable" state (see app/routes/contact.tsx).
   */
  interface Env {
    PUBLIC_TURNSTILE_SITE_KEY?: string;
    OPS_BASE_URL?: string;
  }
}
