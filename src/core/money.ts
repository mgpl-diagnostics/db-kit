import { ValidationError } from "./ports";
import type { InvoiceItem, InvoiceTotals, ItemCategory, Paise, Taxability } from "./types";

export interface ItemInput {
  code?: string;
  name: string;
  category?: ItemCategory;
  qty?: number;
  ratePaise: Paise;
  /** Line discount in paise. */
  discountPaise?: Paise;
  taxPercent?: number;
  /** SAC / HSN code and GST treatment, kept on the invoice line for GST returns. */
  hsnSac?: string;
  taxability?: Taxability;
}

/** Rupees → paise without float drift (399.5 → 39950). */
export const toPaise = (rupees: number): Paise => Math.round(rupees * 100);
export const toRupees = (paise: Paise): number => paise / 100;

/**
 * Splits a bill discount across line amounts in proportion, with the largest-remainder rule, so the
 * shares add up exactly. GST returns use the same shares to recover each line's taxable value.
 */
export function billDiscountShares(amounts: Paise[], billDiscountPaise: Paise): Paise[] {
  const subtotal = amounts.reduce((s, a) => s + a, 0);
  const shares = amounts.map((a) => (subtotal ? (billDiscountPaise * a) / subtotal : 0));
  const floors = shares.map(Math.floor);
  let left = billDiscountPaise - floors.reduce((a, b) => a + b, 0);
  shares
    .map((s, idx) => ({ idx, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ idx }) => { if (left > 0) { floors[idx]! += 1; left--; } });
  return floors;
}

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
    const item: InvoiceItem = { code: i.code, name: i.name, category: i.category ?? "test", qty, ratePaise: i.ratePaise, discountPaise: discount, taxPercent: tax, amountPaise: gross - discount };
    if (i.hsnSac !== undefined) item.hsnSac = i.hsnSac;
    if (i.taxability !== undefined) item.taxability = i.taxability;
    return item;
  });

  const subtotal = items.reduce((s, i) => s + i.amountPaise, 0);
  const billDiscount = Math.min(subtotal, Math.max(0, Math.round(billDiscountPaise)));

  const floors = billDiscountShares(items.map((i) => i.amountPaise), billDiscount);
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
