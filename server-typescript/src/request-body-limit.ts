const DEFAULT_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export async function limitRequestBody(
  request: Request,
  maxSize = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<Request | Response> {
  if (!request.body) {
    return request;
  }

  const hasTransferEncoding = request.headers.has("transfer-encoding");
  const hasContentLength = request.headers.has("content-length");

  if (hasContentLength && !hasTransferEncoding) {
    const contentLength = Number.parseInt(
      request.headers.get("content-length") || "0",
      10,
    );
    if (Number.isFinite(contentLength) && contentLength > maxSize) {
      return new Response("Payload Too Large", { status: 413 });
    }
    return request;
  }

  let size = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxSize) {
      return new Response("Payload Too Large", { status: 413 });
    }
    chunks.push(value);
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Request(request, {
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
