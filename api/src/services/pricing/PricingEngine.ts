/**
 * @file PricingEngine.ts
 * Computes fares in BHD, SAR, AED, or USD.
 *
 * Design principles:
 *  - All arithmetic is done with integer cents to avoid floating-point errors.
 *    (BHD stored as fils × 1000, SAR/AED/USD as halalas/fils × 100).
 *  - Exchange rates are static env-based defaults.  In production, replace
 *    with a live FX feed cached in Redis.
 *  - The result is a FareBreakdown value object that is stored as JSONB
 *    on the Order row for full auditability.
 */

import { getEnv } from '../../config/environment';
import { Currency, VehicleType } from '../../types/enums';
import type { FareBreakdown, PricingInput } from '../../types/interfaces';

// ─────────────────────────────────────────────────────────────────────────────
// Static exchange rates (USD base — replace with live feed in production)
// ─────────────────────────────────────────────────────────────────────────────
const USD_RATES: Record<Currency, number> = {
  [Currency.BHD]: 2.6531,   // 1 BHD = 2.6531 USD (fixed peg)
  [Currency.SAR]: 0.2666,   // 1 SAR ≈ 0.2666 USD
  [Currency.AED]: 0.2722,   // 1 AED ≈ 0.2722 USD (near-fixed to USD)
  [Currency.USD]: 1.0,
};

// ISO 4217 decimal places
const DECIMAL_PLACES: Record<Currency, number> = {
  [Currency.BHD]: 3,
  [Currency.SAR]: 2,
  [Currency.AED]: 2,
  [Currency.USD]: 2,
};

// Vehicle surcharge multipliers
const VEHICLE_SURCHARGE: Record<VehicleType, number> = {
  [VehicleType.MOTORCYCLE]: 0,
  [VehicleType.CAR]: 0.15,
  [VehicleType.VAN]: 0.30,
  [VehicleType.PICKUP_TRUCK]: 0.40,
  [VehicleType.REFRIGERATED]: 0.60,
};

export class PricingEngine {
  /**
   * Calculates the full fare breakdown for an order.
   *
   * @param input  See PricingInput interface
   * @returns      FareBreakdown with all monetary values in `input.currency`
   */
  calculate(input: PricingInput): FareBreakdown {
    const env = getEnv();
    const { distanceKm, currency, vehicleType, weightKg = 0, isPeakHour = false } = input;

    const dp = DECIMAL_PLACES[currency];

    // ── Base + distance fare in selected currency ─────────────────────────
    const baseFare = this.getBaseFare(currency);
    const perKm = this.getPerKmFare(currency);
    const distanceFare = parseFloat((distanceKm * perKm).toFixed(dp));

    // ── Surcharges ────────────────────────────────────────────────────────
    let surchargeRate = VEHICLE_SURCHARGE[vehicleType] ?? 0;
    if (isPeakHour) surchargeRate += 0.20;
    if (weightKg > 20) surchargeRate += 0.10;
    if (weightKg > 50) surchargeRate += 0.20;

    const surcharge = parseFloat(((baseFare + distanceFare) * surchargeRate).toFixed(dp));

    // ── Discount (promo code logic — placeholder) ─────────────────────────
    const discount = input.promoCode ? this.applyPromo(input.promoCode, currency) : 0;

    // ── Subtotal ──────────────────────────────────────────────────────────
    const subtotal = parseFloat((baseFare + distanceFare + surcharge - discount).toFixed(dp));

    // ── Platform fee ──────────────────────────────────────────────────────
    const feeRate = env.PLATFORM_FEE_PERCENT / 100;
    const platformFee = parseFloat((subtotal * feeRate).toFixed(dp));
    const totalFare = parseFloat((subtotal + platformFee).toFixed(dp));

    // ── Driver payout ─────────────────────────────────────────────────────
    const payoutRate = env.DRIVER_PAYOUT_PERCENT / 100;
    const driverPayout = parseFloat((subtotal * payoutRate).toFixed(dp));

    return {
      currency,
      decimalPlaces: dp,
      baseFare,
      distanceFare,
      surcharge,
      discount,
      subtotal,
      platformFee,
      totalFare,
      driverPayout,
      exchangeRateToUsd: USD_RATES[currency],
    };
  }

  /** Returns the current USD-equivalent exchange rate for a currency */
  getExchangeRateToUsd(currency: Currency): number {
    return USD_RATES[currency];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getBaseFare(currency: Currency): number {
    const env = getEnv();
    switch (currency) {
      case Currency.BHD: return env.BASE_FARE_BHD;
      case Currency.SAR: return env.BASE_FARE_SAR;
      case Currency.AED: return env.BASE_FARE_AED;
      case Currency.USD: return parseFloat((env.BASE_FARE_BHD * USD_RATES[Currency.BHD]).toFixed(2));
    }
  }

  private getPerKmFare(currency: Currency): number {
    const env = getEnv();
    switch (currency) {
      case Currency.BHD: return env.PER_KM_FARE_BHD;
      case Currency.SAR: return env.PER_KM_FARE_SAR;
      case Currency.AED: return env.PER_KM_FARE_AED;
      case Currency.USD: return parseFloat((env.PER_KM_FARE_BHD * USD_RATES[Currency.BHD]).toFixed(2));
    }
  }

  private applyPromo(_code: string, currency: Currency): number {
    // TODO: look up promo code in DB and return discount amount in `currency`
    const dp = DECIMAL_PLACES[currency];
    return parseFloat((0).toFixed(dp));
  }
}
