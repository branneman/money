// The headers the spec's "Headers" table puts on every response. Frozen so no
// route can loosen them by accident.

// Every powerful feature off. Listed by name because the policy has no
// "all off" form.
const PERMISSIONS_POLICY = [
  "accelerometer",
  "camera",
  "display-capture",
  "geolocation",
  "gyroscope",
  "hid",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
]
  .map((feature) => `${feature}=()`)
  .join(", ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": PERMISSIONS_POLICY,
  "X-Frame-Options": "DENY",
});

// For every /api/ response and /version.
export const NO_STORE: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
});
