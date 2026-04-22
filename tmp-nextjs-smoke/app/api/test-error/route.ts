import { NextRequest, NextResponse } from 'next/server';
import { withErrorcore } from 'errorcore/nextjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';  // required to prevent Next.js from prerendering this as static at build time

interface User { id: string; tier: 'gold' | 'silver'; }
interface Cart { items: Array<{ price: number; qty: number }>; promoCode?: string; }

function lookupPromo(code: string): number {
  return code === 'WELCOME10' ? 0.1 : 0;
}

function computeUserDiscount(user: User, cart: Cart): number {
  const base = cart.items.reduce((s, it) => s + it.price * it.qty, 0);
  const tierMultiplier = user.tier === 'gold' ? 0.8 : 1.0;
  const promoDiscount = cart.promoCode ? lookupPromo(cart.promoCode) : 0;
  throw new Error(`discount computation boom — base=${base} mult=${tierMultiplier} promo=${promoDiscount}`);
}

async function handler(_req: NextRequest) {
  const user: User = { id: 'u1', tier: 'gold' };
  const cart: Cart = { items: [{ price: 100, qty: 2 }, { price: 50, qty: 1 }], promoCode: 'WELCOME10' };
  computeUserDiscount(user, cart);
  return NextResponse.json({ ok: true });
}

export const GET = withErrorcore(handler);
