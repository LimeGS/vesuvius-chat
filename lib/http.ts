export class ResponseTooLargeError extends Error {
  constructor() { super("Upstream response exceeds the byte limit"); this.name = "ResponseTooLargeError"; }
}

/** Count decoded bytes while streaming, before JSON/SSE parsers can allocate the full payload. */
export async function boundedResponse(response: Response, limit: number): Promise<Response> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); return; }
        bytes += value.byteLength;
        if (bytes > limit) {
          await reader.cancel(); reader.releaseLock();
          controller.error(new ResponseTooLargeError()); return;
        }
        controller.enqueue(value);
      } catch (error) { reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
