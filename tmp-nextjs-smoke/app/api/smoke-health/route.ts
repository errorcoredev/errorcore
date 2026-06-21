import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return NextResponse.json({
    ok: true,
    service: 'tmp-nextjs-smoke',
    runId: req.nextUrl.searchParams.get('runId'),
  });
}
