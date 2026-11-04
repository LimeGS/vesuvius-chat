// Synthetic transport failure only: this process must never reach a network.
globalThis.fetch = async () => new Response("PRIVATE_BENCHMARK_UPSTREAM_SENTINEL", { status: 503 });
