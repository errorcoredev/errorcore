import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return NextResponse.json({
    ok: true,
    service: 'errorcore-nextjs-smoke-fixture',
    runId: req.nextUrl.searchParams.get('runId'),
  });
}
