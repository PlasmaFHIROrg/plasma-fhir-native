/* global window */
import {
    debug as _debug,
    request,
    getPath,
    randomString,
    getAndCache,
    fetchConformanceStatement,
    getAccessTokenExpiration,
    getTargetWindow,
    assert
} from "./lib";
import Client from "./Client";
import { SMART_KEY } from "./settings";
import { fhirclient } from "./types";
import { AbortController } from "abortcontroller-polyfill/dist/cjs-ponyfill";

const debug = _debug.extend("oauth2");

export { SMART_KEY as KEY };

function isBrowser() {
    return typeof window === "object";
}

export class SmartUtil {

    /**
     * Given a FHIR server, returns an object with it's Oauth security endpoints
     * that we are interested in. This will try to find the info in both the
     * `CapabilityStatement` and the `.well-known/smart-configuration`. Whatever
     * Arrives first will be used and the other request will be aborted.
     * @param [baseUrl] Fhir server base URL
     */
    public static getSecurityExtensions(baseUrl = "/"): Promise<fhirclient.OAuthSecurityExtensions> 
    {
        const ac1 = new AbortController();
        const ac2 = new AbortController();
        const requestOptions: RequestInit = { signal: ac1.signal };

        return any([
            {
                controller: ac1,
                promise: getSecurityExtensionsFromWellKnownJson(baseUrl, { signal: ac1.signal })
            },

            {
                controller: ac2,
                promise: getSecurityExtensionsFromConformanceStatement(baseUrl, { signal: ac2.signal })
            }
        ]);

        /*
        const ac = new AbortController();
        const requestOptions: RequestInit = { signal: ac.signal };

        return any([
            {
                controller: ac,
                promise: getSecurityExtensionsFromWellKnownJson(baseUrl, requestOptions)
            },

            {
                controller: ac,
                promise: getSecurityExtensionsFromConformanceStatement(baseUrl, requestOptions)
            }
        ]);
        */
    }

    /**
     * Builds the token request options. Does not make the request, just
     * creates it's configuration and returns it in a Promise.
     */
    public static buildTokenRequest(btoa: (s: string) => string, code: string, 
        redirectUri: string, tokenUri: string, clientId: string, clientSecret?: string): RequestInit
    {
        const requestOptions: Record<string, any> = {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `code=${code}&grant_type=authorization_code&redirect_uri=${
                encodeURIComponent(redirectUri)}`
        };

        // For public apps, authentication is not possible (and thus not required),
        // since a client with no secret cannot prove its identity when it issues a
        // call. (The end-to-end system can still be secure because the client comes
        // from a known, https protected endpoint specified and enforced by the
        // redirect uri.) For confidential apps, an Authorization header using HTTP
        // Basic authentication is required, where the username is the app’s
        // client_id and the password is the app’s client_secret (see example).
        if (clientSecret) {
            requestOptions.headers.Authorization = "Basic " + btoa(clientId + ":" + clientSecret);
            debug("Using state.clientSecret to construct the authorization header: %s", requestOptions.headers.Authorization);
        } else {
            debug("No clientSecret found in state. Adding the clientId to the POST body");
            requestOptions.body += `&client_id=${encodeURIComponent(clientId)}`;
        }

        return requestOptions as RequestInit;
    }

}

/**
 * Fetches the well-known json file from the given base URL.
 * Note that the result is cached in memory (until the page is reloaded in the
 * browser) because it might have to be re-used by the client
 * @param baseUrl The base URL of the FHIR server
 */
export function fetchWellKnownJson(baseUrl = "/", requestOptions?: RequestInit): Promise<fhirclient.WellKnownSmartConfiguration>
{
    const url = String(baseUrl).replace(/\/*$/, "/") + ".well-known/smart-configuration";
    return getAndCache(url, requestOptions).catch((ex: Error) => {
        throw new Error(`Failed to fetch the well-known json "${url}". ${ex.message}`);
    });
}

/**
 * Fetch a "WellKnownJson" and extract the SMART endpoints from it
 */
function getSecurityExtensionsFromWellKnownJson(baseUrl = "/", requestOptions?: RequestInit): Promise<fhirclient.OAuthSecurityExtensions>
{
    return fetchWellKnownJson(baseUrl, requestOptions).then(meta => {
        if (!meta.authorization_endpoint || !meta.token_endpoint) {
            throw new Error("Invalid wellKnownJson");
        }
        return {
            registrationUri: meta.registration_endpoint  || "",
            authorizeUri   : meta.authorization_endpoint,
            tokenUri       : meta.token_endpoint
        };
    });
}

/**
 * Fetch a `CapabilityStatement` and extract the SMART endpoints from it
 */
function getSecurityExtensionsFromConformanceStatement(baseUrl = "/", requestOptions?: RequestInit): Promise<fhirclient.OAuthSecurityExtensions>
{
    return fetchConformanceStatement(baseUrl, requestOptions).then(meta => {
        const nsUri = "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris";
        const extensions = ((getPath(meta || {}, "rest.0.security.extension") || []) as Array<fhirclient.FHIR.Extension<"valueUri">>)
            .filter(e => e.url === nsUri)
            .map(o => o.extension)[0];

        const out = {
            registrationUri : "",
            authorizeUri    : "",
            tokenUri        : ""
        };

        if (extensions) {
            extensions.forEach(ext => {
                if (ext.url === "register") {
                    out.registrationUri = ext.valueUri;
                }
                if (ext.url === "authorize") {
                    out.authorizeUri = ext.valueUri;
                }
                if (ext.url === "token") {
                    out.tokenUri = ext.valueUri;
                }
            });
        }

        return out;
    });
}

interface Task {
    controller: AbortController;
    promise: Promise<any>;
    complete?: boolean;
}

/**
 * This works similarly to `Promise.any()`. The tasks are objects containing a
 * request promise and it's AbortController. Returns a promise that will be
 * resolved with the return value of the first successful request, or rejected
 * with an aggregate error if all tasks fail. Any requests, other than the first
 * one that succeeds will be aborted.
 */
function any(tasks: Task[]): Promise<any> {
    const len = tasks.length;
    const errors: Error[] = [];
    let resolved = false;

    return new Promise((resolve, reject) => {

        function onSuccess(task: Task, result: any) {
            task.complete = true;
            if (!resolved) {
                resolved = true;
                tasks.forEach(t => {
                    if (!t.complete) {
                       t.controller.abort();
                    }
                });
                resolve(result);
            }
        }

        function onError(error: Error) {
            if (errors.push(error) === len) {
                reject(new Error(errors.map(e => e.message).join("; ")));
            }
        }

        tasks.forEach(t => {
            t.promise.then(result => onSuccess(t, result), onError);
        });
    });
}

/**
 * Given a FHIR server, returns an object with it's Oauth security endpoints
 * that we are interested in. This will try to find the info in both the
 * `CapabilityStatement` and the `.well-known/smart-configuration`. Whatever
 * Arrives first will be used and the other request will be aborted.
 * @param [baseUrl] Fhir server base URL
 * @param [env] The Adapter
 */
export function getSecurityExtensions(env: fhirclient.Adapter, baseUrl = "/"): Promise<fhirclient.OAuthSecurityExtensions>
{
    // ERM: RESTORE the original
    return SmartUtil.getSecurityExtensions(baseUrl);

    /* 
    const AbortController = env.getAbortController();
    const abortController1 = new AbortController();
    const abortController2 = new AbortController();

    return any([{
        controller: abortController1,
        promise: getSecurityExtensionsFromWellKnownJson(baseUrl, {
            signal: abortController1.signal
        })
    }, {
        controller: abortController2,
        promise: getSecurityExtensionsFromConformanceStatement(baseUrl, {
            signal: abortController2.signal
        })
    }]);
    /* */
}

/**
 * Starts the SMART Launch Sequence.
 * > **IMPORTANT**:
 *   `authorize()` will end up redirecting you to the authorization server.
 *    This means that you should not add anything to the returned promise chain.
 *    Any code written directly after the authorize() call might not be executed
 *    due to that redirect!
 * @param env
 * @param [params]
 */
export async function authorize(
    env: fhirclient.Adapter,
    params: fhirclient.AuthorizeParams | fhirclient.AuthorizeParams[] = {}
): Promise<string|void>
{
    const url = env.getUrl();

    // Multiple config for EHR launches ---------------------------------------
    if (Array.isArray(params)) {
        const urlISS = url.searchParams.get("iss") || url.searchParams.get("fhirServiceUrl");
        if (!urlISS) {
            throw new Error(
                'Passing in an "iss" url parameter is required if authorize ' +
                'uses multiple configurations'
            );
        }
        // pick the right config
        const cfg = params.find(x => {
            if (x.issMatch) {
                if (typeof x.issMatch === "function") {
                    return !!x.issMatch(urlISS);
                }
                if (typeof x.issMatch === "string") {
                    return x.issMatch === urlISS;
                }
                if (x.issMatch instanceof RegExp) {
                    return x.issMatch.test(urlISS);
                }
            }
            return false;
        });
        assert(cfg, `No configuration found matching the current "iss" parameter "${urlISS}"`);
        return await authorize(env, cfg);
    }
    // ------------------------------------------------------------------------

    // Obtain input
    const {
        redirect_uri,
        clientSecret,
        fakeTokenResponse,
        patientId,
        encounterId,
        client_id,
        target,
        width,
        height
    } = params;

    let {
        iss,
        launch,
        fhirServiceUrl,
        redirectUri,
        noRedirect,
        scope = "",
        clientId,
        completeInTarget
    } = params;

    const storage = env.getStorage();

    // For these three an url param takes precedence over inline option
    iss            = url.searchParams.get("iss")            || iss;
    fhirServiceUrl = url.searchParams.get("fhirServiceUrl") || fhirServiceUrl;
    launch         = url.searchParams.get("launch")         || launch;

    if (!clientId) {
        clientId = client_id;
    }

    if (!redirectUri) {
        redirectUri = redirect_uri;
    }

    if (!redirectUri) {
        redirectUri = env.relative(".");
    } else if (!redirectUri.match(/^https?\:\/\//)) {
        redirectUri = env.relative(redirectUri);
    }

    const serverUrl = String(iss || fhirServiceUrl || "");

    // Validate input
    if (!serverUrl) {
        throw new Error(
            "No server url found. It must be specified as `iss` or as " +
            "`fhirServiceUrl` parameter"
        );
    }

    if (iss) {
        debug("Making %s launch...", launch ? "EHR" : "standalone");
    }

    // append launch scope if needed
    if (launch && !scope.match(/launch/)) {
        scope += " launch";
    }

    if (isBrowser()) {
        const inFrame = isInFrame();
        const inPopUp = isInPopUp();

        if ((inFrame || inPopUp) && completeInTarget !== true && completeInTarget !== false) {
            
            // completeInTarget will default to true if authorize is called from
            // within an iframe. This is to avoid issues when the entire app
            // happens to be rendered in an iframe (including in some EHRs),
            // even though that was not how the app developer's intention.
            completeInTarget = inFrame;

            // In this case we can't always make the best decision so ask devs
            // to be explicit in their configuration.
            console.warn(
                'Your app is being authorized from within an iframe or popup ' +
                'window. Please be explicit and provide a "completeInTarget" ' +
                'option. Use "true" to complete the authorization in the '     +
                'same window, or "false" to try to complete it in the parent ' +
                'or the opener window. See http://docs.smarthealthit.org/client-js/api.html'
            );
        }
    }

    // If `authorize` is called, make sure we clear any previous state (in case
    // this is a re-authorize)
    const oldKey = await storage.get(SMART_KEY);
    await storage.unset(oldKey);

    // create initial state
    const stateKey = randomString(16);
    const state: fhirclient.ClientState = {
        clientId,
        scope,
        redirectUri,
        serverUrl,
        clientSecret,
        tokenResponse: {},
        key: stateKey,
        completeInTarget
    };

    const fullSessionStorageSupport = isBrowser() ?
        getPath(env, "options.fullSessionStorageSupport") :
        true;

    if (fullSessionStorageSupport) {
        await storage.set(SMART_KEY, stateKey);
    }

    // fakeTokenResponse to override stuff (useful in development)
    if (fakeTokenResponse) {
        Object.assign(state.tokenResponse, fakeTokenResponse);
    }

    // Fixed patientId (useful in development)
    if (patientId) {
        Object.assign(state.tokenResponse, { patient: patientId });
    }

    // Fixed encounterId (useful in development)
    if (encounterId) {
        Object.assign(state.tokenResponse, { encounter: encounterId });
    }

    let redirectUrl = redirectUri + "?state=" + encodeURIComponent(stateKey);

    // bypass oauth if fhirServiceUrl is used (but iss takes precedence)
    if (fhirServiceUrl && !iss) {
        debug("Making fake launch...");
        await storage.set(stateKey, state);
        if (noRedirect) {
            return redirectUrl;
        }
        return await env.redirect(redirectUrl);
    }

    // Get oauth endpoints and add them to the state
    const extensions = await getSecurityExtensions(env, serverUrl);
    Object.assign(state, extensions);
    await storage.set(stateKey, state);

    // If this happens to be an open server and there is no authorizeUri
    if (!state.authorizeUri) {
        if (noRedirect) {
            return redirectUrl;
        }
        return await env.redirect(redirectUrl);
    }

    // build the redirect uri
    const redirectParams = [
        "response_type=code",
        "client_id="    + encodeURIComponent(clientId || ""),
        "scope="        + encodeURIComponent(scope),
        "redirect_uri=" + encodeURIComponent(redirectUri),
        "aud="          + encodeURIComponent(serverUrl),
        "state="        + encodeURIComponent(stateKey)
    ];

    // also pass this in case of EHR launch
    if (launch) {
        redirectParams.push("launch=" + encodeURIComponent(launch));
    }

    redirectUrl = state.authorizeUri + "?" + redirectParams.join("&");

    if (noRedirect) {
        return redirectUrl;
    }

    if (target && isBrowser()) {
        let win: Window;

        win = await getTargetWindow(target, width, height);

        if (win !== self) {
            try {
                // Also remove any old state from the target window and then
                // transfer the current state there
                win.sessionStorage.removeItem(oldKey);
                win.sessionStorage.setItem(stateKey, JSON.stringify(state));
            } catch (ex) {
                _debug(`Failed to modify window.sessionStorage. Perhaps it is from different origin?. Failing back to "_self". %s`, ex);
                win = self;
            }
        }

        if (win !== self) {
            try {
                win.location.href = redirectUrl;
                self.addEventListener("message", onMessage);
            } catch (ex) {
                _debug(`Failed to modify window.location. Perhaps it is from different origin?. Failing back to "_self". %s`, ex);
                self.location.href = redirectUrl;
            }
        } else {
            self.location.href = redirectUrl;
        }

        return;
    }
    else {
        return await env.redirect(redirectUrl);
    }
}

/**
 * Checks if called within a frame. Only works in browsers!
 * If the current window has a `parent` or `top` properties that refer to
 * another window, returns true. If trying to access `top` or `parent` throws an
 * error, returns true. Otherwise returns `false`.
 */
export function isInFrame() {
    try {
        return self !== top && parent !== self;
    } catch (e) {
        return true;
    }
}

/**
 * Checks if called within another window (popup or tab). Only works in browsers!
 * To consider itself called in a new window, this function verifies that:
 * 1. `self === top` (not in frame)
 * 2. `!!opener && opener !== self` The window has an opener
 * 3. `!!window.name` The window has a `name` set
 */
export function isInPopUp() {
    try {
        return self === top &&
               !!opener &&
               opener !== self &&
               !!window.name;
    } catch (e) {
        return false;
    }
}

/**
 * Another window can send a "completeAuth" message to this one, making it to
 * navigate to e.data.url
 * @param e The message event
 */
export function onMessage(e: MessageEvent) {
    if (e.data.type == "completeAuth" && e.origin === new URL(self.location.href).origin) {
        window.removeEventListener("message", onMessage);
        window.location.href = e.data.url;
    }
}


/**
 * The completeAuth function should only be called on the page that represents
 * the redirectUri. We typically land there after a redirect from the
 * authorization server..
 */
 export async function ermCompleteAuth(env: fhirclient.Adapter): Promise<Client>
 {
    const btoa = env.btoa;
    const replaceBrowserHistory = env.options.replaceBrowserHistory;
    const fullSessionStorageSupport = isBrowser() 
        ? env.options.fullSessionStorageSupport
        : true;
    
    



     const url = env.getUrl();
     const Storage = env.getStorage();
     const params = url.searchParams;
 
     let key                    = params.get("state");
     const code                 = params.get("code");
     const authError            = params.get("error");
     const authErrorDescription = params.get("error_description");
 
     if (!key) {
         key = await Storage.get(SMART_KEY);
     }
 
     // Start by checking the url for `error` and `error_description` parameters.
     // This happens when the auth server rejects our authorization attempt. In
     // this case it has no other way to tell us what the error was, other than
     // appending these parameters to the redirect url.
     // From client's point of view, this is not very reliable (because we can't
     // know how we have landed on this page - was it a redirect or was it loaded
     // manually). However, if `completeAuth()` is being called, we can assume
     // that the url comes from the auth server (otherwise the app won't work
     // anyway).
     if (authError || authErrorDescription) {
         throw new Error([
             authError,
             authErrorDescription
         ].filter(Boolean).join(": "));
     }
 
     debug("key: %s, code: %s", key, code);
 
     // key might be coming from the page url so it might be empty or missing
     assert(key, "No 'state' parameter found. Please (re)launch the app.");
 
     // Check if we have a previous state
     let state = (await Storage.get(key)) as fhirclient.ClientState;
 
     // If we are in a popup window or an iframe and the authorization is
     // complete, send the location back to our opener and exit.
     if (isBrowser() && state && !state.completeInTarget) {
 
         const inFrame = isInFrame();
         const inPopUp = isInPopUp();
 
         // we are about to return to the opener/parent where completeAuth will
         // be called again. In rare cases the opener or parent might also be
         // a frame or popup. Then inFrame or inPopUp will be true but we still
         // have to stop going up the chain. To guard against that weird form of
         // recursion we pass one additional parameter to the url which we later
         // remove.
         if ((inFrame || inPopUp) && !url.searchParams.get("complete")) {
             url.searchParams.set("complete", "1");
             const { href, origin } = url;
             if (inFrame) {
                 parent.postMessage({ type: "completeAuth", url: href }, origin);
             }
             if (inPopUp) {
                 opener.postMessage({ type: "completeAuth", url: href }, origin);
                 window.close();
             }
 
             return new Promise(() => { /* leave it pending!!! */ });
         }
     }
 
     url.searchParams.delete("complete");
 
     // Do we have to remove the `code` and `state` params from the URL?
     const hasState = params.has("state");
 
     if (isBrowser() && replaceBrowserHistory && (code || hasState)) {
         // `code` is the flag that tell us to request an access token.
         // We have to remove it, otherwise the page will authorize on
         // every load!
         if (code) {
             params.delete("code");
             debug("Removed code parameter from the url.");
         }
 
         // If we have `fullSessionStorageSupport` it means we no longer
         // need the `state` key. It will be stored to a well know
         // location - sessionStorage[SMART_KEY]. However, no
         // fullSessionStorageSupport means that this "well know location"
         // might be shared between windows and tabs. In this case we
         // MUST keep the `state` url parameter.
         if (hasState && fullSessionStorageSupport) {
             params.delete("state");
             debug("Removed state parameter from the url.");
         }
 
         // If the browser does not support the replaceState method for the
         // History Web API, the "code" parameter cannot be removed. As a
         // consequence, the page will (re)authorize on every load. The
         // workaround is to reload the page to new location without those
         // parameters. If that is not acceptable replaceBrowserHistory
         // should be set to false.
         if (window.history.replaceState) {
             window.history.replaceState({}, "", url.href);
         }
     }
 
     // If the state does not exist, it means the page has been loaded directly.
     assert(state, "No state found! Please (re)launch the app.");
 
     // Assume the client has already completed a token exchange when
     // there is no code (but we have a state) or access token is found in state
     const authorized = !code || state.tokenResponse?.access_token;
 
     // If we are authorized already, then this is just a reload.
     // Otherwise, we have to complete the code flow
     if (!authorized && state.tokenUri) {
 
         assert(code, "'code' url parameter is required");
 
         debug("Preparing to exchange the code for access token...");
         const requestOptions = buildTokenRequest(env, code, state);
         debug("Token request options: %O", requestOptions);
 
         // The EHR authorization server SHALL return a JSON structure that
         // includes an access token or a message indicating that the
         // authorization request has been denied.
         const tokenResponse = await request<fhirclient.TokenResponse>(state.tokenUri, requestOptions);
         debug("Token response: %O", tokenResponse);
         assert(tokenResponse.access_token, "Failed to obtain access token.");
 
         // Now we need to determine when is this authorization going to expire
         state.expiresAt = getAccessTokenExpiration(tokenResponse, env);
 
         // save the tokenResponse so that we don't have to re-authorize on
         // every page reload
         state = { ...state, tokenResponse };
         await Storage.set(key, state);
         debug("Authorization successful!");
     }
     else {
         debug(state.tokenResponse?.access_token ?
             "Already authorized" :
             "No authorization needed"
         );
     }
 
     if (fullSessionStorageSupport) {
         await Storage.set(SMART_KEY, key);
     }
 
     const client = new Client(env, state);
     debug("Created client instance: %O", client);
     return client;
 }

/**
 * The completeAuth function should only be called on the page that represents
 * the redirectUri. We typically land there after a redirect from the
 * authorization server..
 */
 export async function aaaCompleteAuth(env: fhirclient.Adapter, key?: string, code?: string, authError?: string, authErrorDescription?: string, accessToken?: string): Promise<Client | null>
 {
     //const Storage = env.getStorage();
 
     /*
     if (!key) {
         key = await Storage.get(SMART_KEY);
     }
     */
 
     // Start by checking the url for `error` and `error_description` parameters.
     // This happens when the auth server rejects our authorization attempt. In
     // this case it has no other way to tell us what the error was, other than
     // appending these parameters to the redirect url.
     // From client's point of view, this is not very reliable (because we can't
     // know how we have landed on this page - was it a redirect or was it loaded
     // manually). However, if `completeAuth()` is being called, we can assume
     // that the url comes from the auth server (otherwise the app won't work
     // anyway).
     if (authError || authErrorDescription) {
         throw new Error([
             authError,
             authErrorDescription
         ].filter(Boolean).join(": "));
     }
 
     debug("key: %s, code: %s", key, code);
 
     // key might be coming from the page url so it might be empty or missing
     assert(key, "No 'state' parameter found. Please (re)launch the app.");
 
     // Check if we have a previous state
     //let state = (await Storage.get(key)) as fhirclient.ClientState;
 
     const fullSessionStorageSupport = isBrowser() ?
         getPath(env, "options.fullSessionStorageSupport") :
         true;
 
     // If the state does not exist, it means the page has been loaded directly.
     //assert(state, "No state found! Please (re)launch the app.");
 
     // Assume the client has already completed a token exchange when
     // there is no code (but we have a state) or access token is found in state
     //const authorized = !code || state.tokenResponse?.access_token;
     const authorized = !code || accessToken;       // ERM:
 
     /*
     // If we are authorized already, then this is just a reload.
     // Otherwise, we have to complete the code flow
     if (!authorized && state.tokenUri) {
 
         assert(code, "'code' url parameter is required");
 
         debug("Preparing to exchange the code for access token...");
         const requestOptions = buildTokenRequest(env, code, state);
         debug("Token request options: %O", requestOptions);
 
         // The EHR authorization server SHALL return a JSON structure that
         // includes an access token or a message indicating that the
         // authorization request has been denied.
         const tokenResponse = await request<fhirclient.TokenResponse>(state.tokenUri, requestOptions);
         debug("Token response: %O", tokenResponse);
         assert(tokenResponse.access_token, "Failed to obtain access token.");
 
         // Now we need to determine when is this authorization going to expire
         state.expiresAt = getAccessTokenExpiration(tokenResponse, env);
 
         // save the tokenResponse so that we don't have to re-authorize on
         // every page reload
         state = { ...state, tokenResponse };
         await Storage.set(key, state);
         debug("Authorization successful!");
     }
     else {
         debug(state.tokenResponse?.access_token ?
             "Already authorized" :
             "No authorization needed"
         );
     }
     */
 
     /*
     if (fullSessionStorageSupport) {
         await Storage.set(SMART_KEY, key);
     }
     */
 
     //const client = new Client(env, undefined as any);
     //debug("Created client instance: %O", client);
     //return client;
     return null;
 }




/**
 * The completeAuth function should only be called on the page that represents
 * the redirectUri. We typically land there after a redirect from the
 * authorization server..
 */
export async function completeAuth(env: fhirclient.Adapter): Promise<Client>
{
    const url = env.getUrl();
    const Storage = env.getStorage();
    const params = url.searchParams;

    let key                    = params.get("state");
    const code                 = params.get("code");
    const authError            = params.get("error");
    const authErrorDescription = params.get("error_description");

    if (!key) {
        key = await Storage.get(SMART_KEY);
    }

    // Start by checking the url for `error` and `error_description` parameters.
    // This happens when the auth server rejects our authorization attempt. In
    // this case it has no other way to tell us what the error was, other than
    // appending these parameters to the redirect url.
    // From client's point of view, this is not very reliable (because we can't
    // know how we have landed on this page - was it a redirect or was it loaded
    // manually). However, if `completeAuth()` is being called, we can assume
    // that the url comes from the auth server (otherwise the app won't work
    // anyway).
    if (authError || authErrorDescription) {
        throw new Error([
            authError,
            authErrorDescription
        ].filter(Boolean).join(": "));
    }

    debug("key: %s, code: %s", key, code);

    // key might be coming from the page url so it might be empty or missing
    assert(key, "No 'state' parameter found. Please (re)launch the app.");

    // Check if we have a previous state
    let state = (await Storage.get(key)) as fhirclient.ClientState;

    const fullSessionStorageSupport = isBrowser() ?
        getPath(env, "options.fullSessionStorageSupport") :
        true;

    // If we are in a popup window or an iframe and the authorization is
    // complete, send the location back to our opener and exit.
    if (isBrowser() && state && !state.completeInTarget) {

        const inFrame = isInFrame();
        const inPopUp = isInPopUp();

        // we are about to return to the opener/parent where completeAuth will
        // be called again. In rare cases the opener or parent might also be
        // a frame or popup. Then inFrame or inPopUp will be true but we still
        // have to stop going up the chain. To guard against that weird form of
        // recursion we pass one additional parameter to the url which we later
        // remove.
        if ((inFrame || inPopUp) && !url.searchParams.get("complete")) {
            url.searchParams.set("complete", "1");
            const { href, origin } = url;
            if (inFrame) {
                parent.postMessage({ type: "completeAuth", url: href }, origin);
            }
            if (inPopUp) {
                opener.postMessage({ type: "completeAuth", url: href }, origin);
                window.close();
            }

            return new Promise(() => { /* leave it pending!!! */ });
        }
    }

    url.searchParams.delete("complete");

    // Do we have to remove the `code` and `state` params from the URL?
    const hasState = params.has("state");

    if (isBrowser() && getPath(env, "options.replaceBrowserHistory") && (code || hasState)) {
        // `code` is the flag that tell us to request an access token.
        // We have to remove it, otherwise the page will authorize on
        // every load!
        if (code) {
            params.delete("code");
            debug("Removed code parameter from the url.");
        }

        // If we have `fullSessionStorageSupport` it means we no longer
        // need the `state` key. It will be stored to a well know
        // location - sessionStorage[SMART_KEY]. However, no
        // fullSessionStorageSupport means that this "well know location"
        // might be shared between windows and tabs. In this case we
        // MUST keep the `state` url parameter.
        if (hasState && fullSessionStorageSupport) {
            params.delete("state");
            debug("Removed state parameter from the url.");
        }

        // If the browser does not support the replaceState method for the
        // History Web API, the "code" parameter cannot be removed. As a
        // consequence, the page will (re)authorize on every load. The
        // workaround is to reload the page to new location without those
        // parameters. If that is not acceptable replaceBrowserHistory
        // should be set to false.
        if (window.history.replaceState) {
            window.history.replaceState({}, "", url.href);
        }
    }

    // If the state does not exist, it means the page has been loaded directly.
    assert(state, "No state found! Please (re)launch the app.");

    // Assume the client has already completed a token exchange when
    // there is no code (but we have a state) or access token is found in state
    const authorized = !code || state.tokenResponse?.access_token;

    // If we are authorized already, then this is just a reload.
    // Otherwise, we have to complete the code flow
    if (!authorized && state.tokenUri) {

        assert(code, "'code' url parameter is required");

        debug("Preparing to exchange the code for access token...");
        const requestOptions = buildTokenRequest(env, code, state);
        debug("Token request options: %O", requestOptions);

        // The EHR authorization server SHALL return a JSON structure that
        // includes an access token or a message indicating that the
        // authorization request has been denied.
        const tokenResponse = await request<fhirclient.TokenResponse>(state.tokenUri, requestOptions);
        debug("Token response: %O", tokenResponse);
        assert(tokenResponse.access_token, "Failed to obtain access token.");

        // Now we need to determine when is this authorization going to expire
        state.expiresAt = getAccessTokenExpiration(tokenResponse, env);

        // save the tokenResponse so that we don't have to re-authorize on
        // every page reload
        state = { ...state, tokenResponse };
        await Storage.set(key, state);
        debug("Authorization successful!");
    }
    else {
        debug(state.tokenResponse?.access_token ?
            "Already authorized" :
            "No authorization needed"
        );
    }

    if (fullSessionStorageSupport) {
        await Storage.set(SMART_KEY, key);
    }

    const client = new Client(env, state);
    debug("Created client instance: %O", client);
    return client;
}

/**
 * Builds the token request options. Does not make the request, just
 * creates it's configuration and returns it in a Promise.
 */
export function buildTokenRequest(env: fhirclient.Adapter, code: string, state: fhirclient.ClientState): RequestInit
{
    assert(state.redirectUri, "Missing state.redirectUri");
    assert(state.tokenUri, "Missing state.tokenUri");
    assert(state.clientId, "Missing state.clientId");
    return SmartUtil.buildTokenRequest(env.btoa, code, state.redirectUri, state.tokenUri, state.clientId, state.clientSecret);
}

// ERM:
export async function aaaReady(env: fhirclient.Adapter, state?: string, code?: string, authError?: string, authErrorDescription?: string, accessToken?: string, onSuccess?: (client: Client) => any, onError?: (error: Error) => any): Promise<Client>
{
    let task = aaaCompleteAuth(env, state, code, authError, authErrorDescription, accessToken);
    if (onSuccess) {
        task = task.then(onSuccess);
    }
    if (onError) {
        task = task.catch(onError);
    }
    return task;
}

/**
 * @param env
 * @param [onSuccess]
 * @param [onError]
 */
export async function ready(env: fhirclient.Adapter, onSuccess?: (client: Client) => any, onError?: (error: Error) => any): Promise<Client>
{
    let task = completeAuth(env);
    if (onSuccess) {
        task = task.then(onSuccess);
    }
    if (onError) {
        task = task.catch(onError);
    }
    return task;
}

/**
 * This function can be used when you want to handle everything in one page
 * (no launch endpoint needed). You can think of it as if it does:
 * ```js
 * authorize(options).then(ready)
 * ```
 *
 * **Be careful with init()!** There are some details you need to be aware of:
 *
 * 1. It will only work if your launch_uri is the same as your redirect_uri.
 *    While this should be valid, we can’t promise that every EHR will allow you
 *    to register client with such settings.
 * 2. Internally, `init()` will be called twice. First it will redirect to the
 *    EHR, then the EHR will redirect back to the page where init() will be
 *    called again to complete the authorization. This is generally fine,
 *    because the returned promise will only be resolved once, after the second
 *    execution, but please also consider the following:
 *    - You should wrap all your app’s code in a function that is only executed
 *      after `init()` resolves!
 *    - Since the page will be loaded twice, you must be careful if your code
 *      has global side effects that can persist between page reloads
 *      (for example writing to localStorage).
 * 3. For standalone launch, only use init in combination with offline_access
 *    scope. Once the access_token expires, if you don’t have a refresh_token
 *    there is no way to re-authorize properly. We detect that and delete the
 *    expired access token, but it still means that the user will have to
 *    refresh the page twice to re-authorize.
 * @param env The adapter
 * @param options The authorize options
 */
export async function init(env: fhirclient.Adapter, options: fhirclient.AuthorizeParams): Promise<Client|never>
{
    const url   = env.getUrl();
    const code  = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    // if `code` and `state` params are present we need to complete the auth flow
    if (code && state) {
        return completeAuth(env);
    }

    // Check for existing client state. If state is found, it means a client
    // instance have already been created in this session and we should try to
    // "revive" it.
    const storage = env.getStorage();
    const key     = state || await storage.get(SMART_KEY);
    const cached  = await storage.get(key);
    if (cached) {
        return new Client(env, cached);
    }

    // Otherwise try to launch
    return authorize(env, options).then(() => {
        // `init` promises a Client but that cannot happen in this case. The
        // browser will be redirected (unload the page and be redirected back
        // to it later and the same init function will be called again). On
        // success, authorize will resolve with the redirect url but we don't
        // want to return that from this promise chain because it is not a
        // Client instance. At the same time, if authorize fails, we do want to
        // pass the error to those waiting for a client instance.
        return new Promise(() => { /* leave it pending!!! */ });
    });
}