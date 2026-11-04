import { handleMcp } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handleMcp(request, process.env);
export const GET = POST;
export const DELETE = POST;
