/**
 * Single source of truth for client-specific branding and pricing.
 * Swap or override (via env) to re-skin Voxaris Pitch for a customer's workspace.
 *
 * Env overrides (optional):
 *   PITCH_COMPANY_NAME, PITCH_PHONE, PITCH_EMAIL, PITCH_WEBSITE
 *   NEXT_PUBLIC_PITCH_COMPANY_NAME (for client-side display)
 *
 * ROOFAI_* env names are deprecated aliases (see lib/env-branding.ts).
 */

import { envBrand, envBrandFlag } from "@/lib/env-branding";

export type BrandConfig = {
  companyName: string;
  productName: string;
  vendorName: string;
  tagline: string;
  /** Hex — used in PDF header bar */
  primaryColor: string;
  /** Hex — accent (matches the cyan glow in the UI) */
  accentColor: string;
  phone: string;
  email: string;
  websiteUrl: string;
  /** When true, sales output (PDF, Results panel) shows full Xactimate-style line items */
  showXactimateCodes: boolean;
  /** Overhead + profit applied on top of the subtotal */
  defaultMarkup: { overheadPercent: number; profitPercent: number };
  /** Override default $/sq pricing per material if you have local data */
  materialPriceOverrides?: Partial<Record<MaterialPriceKey, { low: number; high: number }>>;
};

export type MaterialPriceKey =
  | "RFG_3T"
  | "RFG_ARCH"
  | "RFG_METAL"
  | "RFG_TILE"
  | "RFG_SHGLR"
  | "RFG_DEPSTL"
  | "RFG_DECK"
  | "RFG_SYNF"
  | "RFG_IWS"
  | "RFG_DRIP"
  | "RFG_VAL"
  | "RFG_STARTER"
  | "RFG_RIDG"
  | "RFG_RDGV"
  | "RFG_PIPEFL";

export const BRAND_CONFIG: BrandConfig = {
  // Customer-facing org name (what appears on the proposal PDF). For internal Voxaris use,
  // this defaults to the product brand. White-label per workspace via PITCH_COMPANY_NAME.
  companyName: envBrand("COMPANY_NAME", "Voxaris Pitch"),
  productName: "Pitch",
  vendorName: "Voxaris",
  tagline: envBrand("TAGLINE", "Estimate to deal in five minutes."),
  primaryColor: envBrand("PRIMARY_COLOR", "#07090d"),
  accentColor: envBrand("ACCENT_COLOR", "#67dcff"),
  phone: envBrand("PHONE", ""),
  email: envBrand("EMAIL", ""),
  websiteUrl: envBrand("WEBSITE", ""),
  showXactimateCodes: envBrandFlag("SHOW_XACTIMATE", false),
  defaultMarkup: { overheadPercent: 10, profitPercent: 10 },
};

/**
 * Material unit prices ($/SQ or $/LF or $/SF) — Xactimate-style codes.
 * Override per-client via BRAND_CONFIG.materialPriceOverrides.
 *
 * Paired with MATERIAL_RATES in lib/pricing.ts — see the long-form
 * comment there. The two tables view the same costs from different
 * angles (this one component-by-component, the other as a per-sqft
 * installed rollup). When you bump one, audit the other in the same
 * commit.
 */
export const DEFAULT_MATERIAL_PRICES: Record<
  MaterialPriceKey,
  { low: number; high: number }
> = {
  RFG_3T: { low: 245, high: 350 },
  RFG_ARCH: { low: 285, high: 425 },
  RFG_METAL: { low: 850, high: 1400 },
  RFG_TILE: { low: 950, high: 1700 },
  RFG_SHGLR: { low: 65, high: 85 },
  RFG_DEPSTL: { low: 55, high: 75 },
  RFG_DECK: { low: 2.85, high: 4.5 },
  RFG_SYNF: { low: 25, high: 40 },
  RFG_IWS: { low: 95, high: 140 },
  RFG_DRIP: { low: 2.85, high: 4.25 },
  RFG_VAL: { low: 8.5, high: 14 },
  RFG_STARTER: { low: 2.45, high: 3.8 },
  RFG_RIDG: { low: 8.25, high: 12.5 },
  RFG_RDGV: { low: 11.5, high: 18 },
  RFG_PIPEFL: { low: 45, high: 75 },
};

export function getMaterialPrice(key: MaterialPriceKey): { low: number; high: number } {
  return BRAND_CONFIG.materialPriceOverrides?.[key] ?? DEFAULT_MATERIAL_PRICES[key];
}
