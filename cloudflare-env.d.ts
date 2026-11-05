declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    EVE_TOKEN_KEY?: string;
    EVE_SITE_ORIGIN?: string;
  }
}
