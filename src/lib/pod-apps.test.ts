import { describe, it, expect } from "vitest";
import { POD_APP_URL, podAppLaunchUrl } from "./pod-apps.js";

describe("podAppLaunchUrl — launcher autologin URL", () => {
  it("returns the bare app URL when no WebID is given (signed out)", () => {
    expect(podAppLaunchUrl("drive")).toBe(POD_APP_URL.drive);
    expect(podAppLaunchUrl("drive", undefined)).toBe(POD_APP_URL.drive);
  });

  it("appends `#autologin/<encodeURIComponent(webId)>` when a WebID is given", () => {
    const webId = "https://alice.solid-test.jeswr.org/profile/card#me";
    expect(podAppLaunchUrl("drive", webId)).toBe(
      `${POD_APP_URL.drive}#autologin/${encodeURIComponent(webId)}`,
    );
  });

  it("URL-encodes the WebID so its own `#me` fragment doesn't break the URL", () => {
    const webId = "https://alice.example/profile/card#me";
    const href = podAppLaunchUrl("photos", webId);
    // Exactly ONE `#` (the autologin fragment marker); the WebID's `#me`
    // is encoded to `%23me`, so it cannot be read as a second fragment.
    expect(href.split("#").length).toBe(2);
    expect(href).toContain("%23me");
    expect(href).not.toContain("card#me");
    // Round-trips: strip the prefix, decode → the original WebID.
    const decoded = decodeURIComponent(href.replace(`${POD_APP_URL.photos}#autologin/`, ""));
    expect(decoded).toBe(webId);
  });

  it("encodes reserved characters in the WebID (slashes, colons, query chars)", () => {
    const webId = "https://idp.example/u?x=1&y=2#me";
    const href = podAppLaunchUrl("docs", webId);
    expect(href.startsWith(`${POD_APP_URL.docs}#autologin/`)).toBe(true);
    // No raw `?`, `&`, or second `#` leaks into the URL from the WebID.
    const fragment = href.replace(`${POD_APP_URL.docs}#autologin/`, "");
    expect(fragment).not.toContain("?");
    expect(fragment).not.toContain("&");
    expect(fragment).not.toContain("#");
    expect(decodeURIComponent(fragment)).toBe(webId);
  });
});
