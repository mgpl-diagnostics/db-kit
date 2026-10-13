import { ValidationError } from "./ports";
import type { InvoiceItem, InvoiceTotals, ItemCategory, Paise } from "./types";

export interface ItemInput {
  code?: string;
  name: string;
  category?: ItemCategory;
  qty?: number;
  ratePaise: Paise;
  /** Line discount in paise. */
  discountPaise?: Paise;
  taxPercent?: number;
}

/** Rupees → paise without float drift (399.5 → 39950). */
export const toPaise = (rupees: number): Paise => Math.round(rupees * 100);
export const toRupees = (paise: Paise): number => paise / 100;

/**
 * Lines and totals, all integer paise:
 *   line amount = qty × rate − line discount
 *   bill discount is shared across lines in proportion (largest remainder, so shares add up exactly)
 *   tax per line on (amount − its share), then the total rounds to the nearest rupee.
 */
export function computeTotals(input: ItemInput[], billDiscountPaise: Paise = 0): { items: InvoiceItem[]; totals: InvoiceTotals } {
  const items: InvoiceItem[] = input.map((i) => {
    const qty = i.qty ?? 1;
    if (!(qty > 0)) throw new ValidationError(`Quantity must be positive (${i.name})`);
    if (!(i.ratePaise >= 0)) throw new ValidationError(`Rate must not be negative (${i.name})`);
    const gross = Math.round(qty * i.ratePaise);
    const discount = Math.min(gross, Math.max(0, Math.round(i.discountPaise ?? 0)));
    const tax = i.taxPercent ?? 0;
    if (tax < 0 || tax > 100) throw new ValidationError(`Tax must be 0–100% (${i.name})`);
    return { code: i.code, name: i.name, category: i.category ?? "test", qty, ratePaise: i.ratePaise, discountPaise: discount, taxPercent: tax, amountPaise: gross - discount };
  });

  const subtotal = items.reduce((s, i) => s + i.amountPaise, 0);
  const billDiscount = Math.min(subtotal, Math.max(0, Math.round(billDiscountPaise)));

  // largest-remainder share of the bill discount
  const shares = items.map((i) => (subtotal ? (billDiscount * i.amountPaise) / subtotal : 0));
  const floors = shares.map(Math.floor);
  let left = billDiscount - floors.reduce((a, b) => a + b, 0);
  shares
    .map((s, idx) => ({ idx, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ idx }) => { if (left > 0) { floors[idx]! += 1; left--; } });

  const tax = items.reduce((s, i, idx) => s + Math.round(((i.amountPaise - floors[idx]!) * i.taxPercent) / 100), 0);
  const exact = subtotal - billDiscount + tax;
  const total = Math.round(exact / 100) * 100;
  return {
    items,
    totals: {
      subtotalPaise: subtotal,
      discountPaise: billDiscount + items.reduce((s, i) => s + i.discountPaise, 0),
      taxPaise: tax,
      roundOffPaise: total - exact,
      totalPaise: total,
    },
  };
}
