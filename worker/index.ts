/** Cloudflare Worker entry point. Atlas API routes run before Vinext. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleApiRequest, type ApiEnvironment } from "../lib/api/router";

interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

interface ImageBinding {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
}

interface Env extends ApiEnvironment {
  ASSETS: AssetBinding;
  IMAGES?: ImageBinding;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // `vinext start` invokes the Worker without a bindings object when no local
    // bindings are declared. API routes must still serve deterministic replay
    // and report live mode as unconfigured instead of throwing.
    const apiResponse = await handleApiRequest(request, env ?? {});
    if (apiResponse) return apiResponse;

    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      if (!env?.IMAGES || !env.ASSETS) return new Response("Image binding unavailable", { status: 503 });
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES!.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
