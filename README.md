# Messaging Form Core

Portable JavaScript validation, browser enhancement and HTTP processing for custom messaging forms.

Development candidate `0.1.0-dev.0`. Not published. Node 24 unit tests are available; browser, Cloudflare runtime and production integration acceptance are pending. The package currently blocks npm publication. Licensed under MIT; see LICENSE.

## Boundaries

- The root entrypoint provides shared identity validation and protocol version 1.
- `/browser` enhances an existing HTML form without Astro or another rendering framework.
- `/server` processes POST requests using standard Request, Response, FormData and Streams APIs.
- Renderers, routes, authorization, rate limiting, credentials, retention, deployment and provider selection belong to the consuming application or a host adapter.
- No analytics, storage, telemetry, automatic provider calls or install hooks are included. There are no runtime dependencies.

## Identity validation

```js
import { createIdentityValidator } from '@ehven/messaging-form-core';

const validate = createIdentityValidator({
  allowedSources: ['contact'],
  emailConfirmation: true,
  required: { firstName: true, lastName: false, email: true, source: true },
  limits: { firstName: 80, lastName: 80, email: 254, source: 80 },
});
```

Defaults use `first_name`, `last_name`, `email`, `email_confirmation`, `source` and the `website` honeypot. All four identity/source fields are required by default. Confirmation comparison is case-insensitive; the delivered email retains its case. Whitespace is normalized and disallowed control characters are rejected. Limits count JavaScript UTF-16 code units, preserving the existing interface. Email validation checks shape, not ownership or deliverability. `validateFormIdentity(values)` uses the default policy.

`fieldNames` can map `firstName`, `lastName`, `email`, `confirmation`, `source` and `honeypot` to unique input names. Declare changed names in the server handler's `fields` option too. `messages` maps keys such as `firstName.required` or `confirmation.mismatch` to localized strings. `allowedSources` is optional; the host must decide source authorization. Unknown option keys and invalid limits/mappings fail early. Configuration is explicitly imported/injected; the package does not search the filesystem or read environment variables.

Results have `{ok, spam, errors, data}`. Errors have `{field, code, message}`. Identity data has `{firstName, lastName, email, source}`; it excludes the confirmation and honeypot. A schema can extend `data` and add errors before passing the result to the server handler. Browser validation is supplementary: validate again on the server.

## Browser enhancement

Render accessible ordinary HTML using your platform:

```html
<form action="/api/message" method="post" id="contact">
  <input type="hidden" name="source" value="contact">
  <label>First name <input name="first_name" autocomplete="given-name" required maxlength="80"></label>
  <label>Last name <input name="last_name" autocomplete="family-name" maxlength="80"></label>
  <label>Email <input name="email" type="email" autocomplete="email" required maxlength="254"></label>
  <label>Email again <input name="email_confirmation" type="email" autocomplete="off" required maxlength="254"></label>
  <p data-form-status hidden></p>
  <button type="submit">Send</button>
</form>
```

```js
import { enhanceMessagingForm } from '@ehven/messaging-form-core/browser';

const controller = enhanceMessagingForm(document.querySelector('#contact'), {
  verification: { reset: ({form}) => resetThisFormsVerificationWidget(form) },
});

// On host navigation/removal:
controller.destroy();
```

The reset function is supplied by your verification integration. It must target that form's widget; no provider SDK is automatically loaded. The example needs an actual human-verification widget/token before connecting it to a protected server. Style fields/status/buttons in the host and add a disclosure matching your actual data handling. A honeypot may be added by the renderer with appropriate offscreen styling and exclusion from accessibility/focus.

The controller submits FormData, requests JSON, disables submit buttons while pending, associates server errors with controls, preserves existing help-text references, preserves entries after failure and resets after accepted/simulated success by default. Messages are customizable. `resetOnSuccess:false` preserves values after success too. It dispatches `messaging:result` with `{ok:true,outcome}` on success. Repeated initialization returns the existing controller; call `destroy()` before changing its options. Destroy aborts pending browser work and restores package-owned status/error state, including original status nodes.

Options include `status`, `endpoint`, `fetchImpl`, `timeoutMs` (30000 default), `messages`, `verification`, `resetOnSuccess`, and `allowCrossOrigin` (false default). Cross-origin requests omit credentials; the endpoint must separately enforce origin/CORS policy. No automatic retries occur. A network failure does not prove the server failed to record the message.

`revealMessagingFields(group, expanded, {animate, duration})` handles hidden/inert/ARIA state and optional native animation with reduced-motion handling. `restoreMessagingFields(group)` restores the original reveal state. The renderer/handler separately owns child disabled/required state. Collapse must exclude inactive controls from submission; this helper alone does not disable them.

## Server processing

```js
import { createIdentityValidator } from '@ehven/messaging-form-core';
import { handleMessagingRequest } from '@ehven/messaging-form-core/server';

const validate = createIdentityValidator({ allowedSources: ['contact'], required: {lastName:false} });

export function processMessage(request, env, {verifyHuman, deliver}) {
  // The host authorizes and rate-limits before calling this function.
  return handleMessagingRequest(request, env, {
    validate, verifyHuman, deliver,
    successLocation: () => '/thank-you/',
    simulationLocation: () => '/simulation-complete/',
  });
}
```

`verifyHuman({request,env,formData,signal})` returns `{ok:boolean}`. Its implementation verifies the actual provider token server-side and enforces expected hostname/action. Missing, throwing or malformed verification fails closed. The handler has no built-in Turnstile requirement or secret loader. `verificationField` defaults to `cf-turnstile-response` for compatibility; set it for other mechanisms.

`deliver(data,{request,env,formData,signal})` must throw on failure or return `{ok:false}`. A successful callback returns `{ok:true,outcome:'accepted'}`. An undefined result retains compatibility with existing throw-on-failure callbacks. Simulation returns `{ok:true,outcome:'simulated'}` and must actually prevent outbound actions in the host. The core identifies simulation honestly; it cannot prevent an injected callback from performing an outbound action.

Custom validators receive `(values,formData,{signal})`; add extra scalar names using `fields`. Missing/malformed validators fail closed. Known scalar duplicates, file uploads, unsupported methods/media and oversized requests are rejected. URL-encoded and multipart bodies are supported. The default read bound is 32768 bytes and 64 entries; `maxRequestBytes` and `maxFields` select bounded alternatives. Each read/validation/verification/delivery stage has `timeoutMs` (15000 default), rather than one overall deadline. Callbacks should honor the abort signal; timeout cannot undo an already completed side effect.

JSON responses include `{ok,outcome,message}` on success and `{ok:false,code,message,errors}` on failure. Accepted returns 202; simulation returns 200. HTML success redirects using 303 to a safe same-origin-relative path, with `/` as fallback. HTML simulation requires its own destination or returns explicit simulation text; it never uses the real sent-state fallback. HTML errors use plain text. All responses are no-store. The handler does not expose provider errors, bodies or secrets. The host owns logging; do not log raw submissions, email addresses, verification tokens or credentials.

No automatic retry or persistent deduplication is implemented in this candidate. Rate limiting and human verification do not establish exactly-once delivery. The host must define idempotency/retry policy before production use. A provider controller should preserve accepted CRM recording when later acknowledgment email fails.

## Host integration

Astro components can render the documented HTML and initialize the browser controller. No `.astro` component ships in core. A WordPress theme/plugin can render the same markup and select an external JavaScript endpoint or a native PHP handler implementing protocol version 1. PHP cannot execute the JavaScript server entrypoint. JavaScript/PHP behavior must be compared with shared contract fixtures before claiming parity. Webflow/HubSpot custom forms require their own initialization and submission-ownership checks.

Use consumer-owned `config/packages/npm/messaging-form-core/index.json` for declarative policy where useful, explicitly import it in the host, and keep secrets in the host's secret storage. No empty config is required for default-only use.

Removal: destroy each browser controller; restore reveal groups; remove host script imports, markup and routes as appropriate. The core creates no persistent records to delete. Removing it does not erase existing provider records, so follow the application's retention/deletion procedure.

This candidate is verified only by the recorded Node unit checks. Browser layout/accessibility, multi-browser behavior, Cloudflare runtime operation, Astro migration and WordPress processing are still acceptance work. No platform adapter, hosted endpoint or public support SLA is supplied by this package version.
