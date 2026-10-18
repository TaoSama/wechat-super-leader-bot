import compression from "compression";
import type { RequestHandler } from "express";
import { constants } from "node:zlib";

const HISTORY_PATH = /^\/v1\/sessions\/[^/]+\/[^/]+\/history\/?$/;
const WEB_ASSET_PATH = /^\/assets\/.+\.(?:js|css)$/i;
const COMPRESSION_THRESHOLD_BYTES = 1024;
const COMPRESSION_LEVEL = 4;

/** Limit buffering/compression to completed read responses, leaving streams untouched. */
export function createReadResponseCompression(): RequestHandler {
  const compress = compression({
    threshold: COMPRESSION_THRESHOLD_BYTES,
    level: COMPRESSION_LEVEL,
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: COMPRESSION_LEVEL } },
    filter: (req, res) => {
      if (res.statusCode !== 200) return false;
      const contentType = String(res.getHeader("Content-Type") ?? "").split(";")[0];
      const expectedType = HISTORY_PATH.test(req.originalUrl.split("?")[0])
        ? contentType === "application/json"
        : ["text/javascript", "application/javascript", "text/css"].includes(contentType);
      return expectedType && compression.filter(req, res);
    },
  });

  return (req, res, next) => {
    if (req.method === "GET" && (HISTORY_PATH.test(req.path) || WEB_ASSET_PATH.test(req.path))) {
      compress(req, res, next);
      return;
    }
    next();
  };
}
