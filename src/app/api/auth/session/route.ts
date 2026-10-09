import { NextRequest, NextResponse } from "next/server";
import { apiResponse, requireSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  return apiResponse(async () => NextResponse.json({ user: (await requireSession(request)).user }));
}
