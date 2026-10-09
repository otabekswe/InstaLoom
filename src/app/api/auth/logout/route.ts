import { NextRequest } from "next/server";
import { apiResponse, requireSameOrigin, revokeSession } from "@/lib/auth";

export async function POST(request: NextRequest) {
  return apiResponse(() => {
    requireSameOrigin(request);
    return revokeSession(request);
  });
}
