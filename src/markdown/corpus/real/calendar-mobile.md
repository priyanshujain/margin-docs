# Android and iOS

The same Rust core and the same React app, with a different shape of chrome and a different way of
getting a token back from Google. Nothing is forked: the layout switches on a `data-phone`
attribute and the OAuth flow switches on `cfg(mobile)`.

## Signing in, and what console work buys you

Both platforms sign in out of the box with the `installed` client the desktop build already uses.
Android is finished at that point. iOS works, but signs the user in from scratch, and one OAuth
client fixes it. That asymmetry is the whole of this section.

### The flow that needs nothing

A phone uses the desktop client, secret and all, and catches Google's answer on the same loopback
listener the desktop flow binds. Two facts make that work: a Desktop client may redirect to loopback
on **any** port with nothing registered in advance, and Google's token endpoint validates the client
id, the secret and the redirect URI without any way of knowing which operating system is asking.
Client types are policy guidance rather than a protocol check.

What used to make this impossible on a phone was not the protocol. It was that opening the consent
page in Safari or Chrome sends the user to another app, iOS suspends this process, and a suspended
process is not accepting on its socket, so the redirect carrying the code arrives at nobody. The
consent page now opens **in front of** the app instead, in the system's own browser component:
`SFSafariViewController` on iOS, a Chrome Custom Tab on Android. This app stays foreground and its
listener stays live. `src-tauri/src/google/browser.rs` is all of it.

Still the system browser, note, and never a WebView this app owns. Google blocks that outright with
`disallowed_useragent`, and it deserves to be blocked, because a webview the app controls can read
the password typed into it. A Safari sheet or a Custom Tab is a different process with the browser's
own cookies and autofill and an address bar the app cannot forge.

**Be clear about the trade.** Reusing a Desktop client from a phone is off Google's stated guidance,
which says to create an Android or iOS client per platform. It works because the protocol does not
check, not because Google blesses it. If Google ever starts enforcing the guidance the symptom will
be a rejected token exchange, and the fix is a per-platform client, which the code already supports
in full.

### Why Android needs nothing else

A Custom Tab is Chrome. It reads Chrome's cookie jar, so an account already signed in there is
offered by name and there is no password to type. Loopback and shared session at once, for nothing.

### Why iOS wants an `ios` client

`SFSafariViewController` has not shared cookies with Safari since iOS 11: every app gets its own
storage. So the no-setup iOS flow puts a real Safari view in front of the user with an empty cookie
jar behind it, and Google has no idea who they are. It signs in. It just asks for a full login every
time the token store is emptied.

`ASWebAuthenticationSession` is the API Apple shipped for exactly this, and it is the only one that
shares Safari's session, which is why iOS puts up its own "wants to use google.com to sign in"
prompt before it opens. But it intercepts a custom scheme and nothing else, never an http loopback
redirect, so on iOS a shared session and loopback are mutually exclusive. Adding an `ios` block is
what buys the scheme, and with it the good version.

So `auth.rs` runs three flows, not two: loopback everywhere by default, `ASWebAuthenticationSession`
plus the custom scheme when there is an `ios` client, and the external browser plus the deep link
when there is an `android` one. `load_credentials` decides once, by whether the block is in the
file.

An iOS client is about a minute of work: it wants the bundle identifier and nothing else, no
fingerprint, no keystore. An Android client wants a SHA-1 per signing key and buys nothing, so
there is no reason to make one unless Google forces the issue.

One thing observed rather than assumed, and worth knowing before anyone re-tests this on a
simulator: a cookie set in the simulator's Safari showed up in neither surface, including
`ASWebAuthenticationSession` after its sharing prompt was accepted. The prompt appears and the
plumbing is right, so this looks like the simulator not backing the shared jar rather than the API.
Judge the session sharing on a real device.

## Creating the per-platform clients

Both mobile clients are **public**: no client secret exists, and PKCE is the only thing between an
intercepted authorization code and a token. That is why the verifier is not optional anywhere in
`auth.rs`.

In the Google Cloud console, on the same project that already has the Calendar API enabled:

1. Create an OAuth client of type **Android**. It wants the package name, which is
   `studio.margin.calendar`, and the SHA-1 fingerprint of the certificate that signs the build.
   For a debug build that is the shared debug keystore:

   ```
   keytool -list -v -keystore ~/.android/debug.keystore \
     -alias androiddebugkey -storepass android -keypass android
   ```

   A release build is signed with a different key and needs its fingerprint added too. An APK
   signed by a key Google has not been told about fails at consent, not at build.

2. Create an OAuth client of type **iOS**. It wants the bundle identifier, which is also
   `studio.margin.calendar`.

3. Put the client ids in `google-credentials.json` alongside the desktop one, matching
   `google-credentials.example.json`:

   ```json
   {
     "installed": { "client_id": "...", "client_secret": "...", "...": "..." },
     "android": { "client_id": "YOUR_ANDROID_CLIENT_ID.apps.googleusercontent.com" },
     "ios": { "client_id": "YOUR_IOS_CLIENT_ID.apps.googleusercontent.com" }
   }
   ```

   The file is gitignored and embedded at build time. Adding a block for one platform leaves the
   other on loopback: the choice is per platform, not per file.

A refresh token belongs to the client that obtained it, so adding or removing a block invalidates
whatever is already stored on that device. Disconnect and reconnect the account afterwards.

## The redirect schemes

These matter only for the flow above. The loopback flow redirects to `http://127.0.0.1:PORT` and
never touches a scheme.

Android redirects to `studio.margin.calendar:/oauth2redirect`. That is the package name, which is
Google's documented form for an Android client, and being known at build time means it can sit in
`AndroidManifest.xml` permanently rather than being pasted in per install.

iOS gets no such choice. Google requires the reversed client id, so the scheme is only knowable
once your client id is: take the client id, drop the `.apps.googleusercontent.com` suffix, and
prefix `com.googleusercontent.apps.`.

Register it in `src-tauri/tauri.conf.json`, as a second entry in the deep link plugin's scheme
list:

```json
"deep-link": {
  "desktop": { "schemes": ["studio.margin.calendar"] },
  "mobile": [{ "scheme": ["studio.margin.calendar", "com.googleusercontent.apps.YOUR_ID"] }]
}
```

Not in `Info.plist`. Editing that by hand looks like it works and then silently stops working: the
plugin's build script rewrites `CFBundleURLTypes` wholesale from this config on every build, and
when the `mobile` array is empty it deletes the key outright. That one empty array is why the
callback was dead on both platforms at first, so if a deep link ever stops arriving, look here
before anywhere else.

The `studio.margin.calendar` scheme stays registered on both platforms whether or not anything
uses it, because the OS is told about a scheme at install time and cannot be told about one later.

If the console shows you something different from either default, put it in the client's block in
`google-credentials.json` as `redirect_uri` and it wins over both. Whatever you put there still
has to have its scheme registered above, or the OS has no reason to hand the link to this app.

## The consent browser, and taking it away again

Neither surface closes itself once the redirect has landed, so `browser.rs` dismisses both. What is
on screen by then is the listener's own "you can close this" page, and leaving it up would look
like a sign-in that hung while the token exchange quietly succeeded behind it.

On iOS that is a `dismissViewControllerAnimated:` on the main thread. `SFSafariViewController` has
no objc2 binding, since `objc2-safari-services` covers only the macOS extension API, so the class
is reached by name and the SafariServices framework is linked by hand to put it in the process at
all. The controller and its delegate are both retained for the length of the flow: UIKit holds a
delegate weakly, and a controller nothing retains deallocates mid-sign-in.

On Android a Custom Tab belongs to Chrome and cannot be closed by the app that launched it. What
works instead is starting `MainActivity` with `FLAG_ACTIVITY_CLEAR_TOP | FLAG_ACTIVITY_SINGLE_TOP`,
which brings this app back to the front of the task the tab was launched into and pops the tab off
on the way. Same move AppAuth makes.

Closing the browser by hand is the other exit, and it has to be noticed or the accounts panel waits
on a sign-in that will never arrive. iOS gets it directly from `safariViewControllerDidFinish:`.
Android has no such callback, so it reads a process resume while a consent attempt is in flight,
which means the tab is gone: the tab is in this app's own task, and dismissal is the only way out
of it. Either way `await_code` sees the flag on its next poll and gives up.

`ASWebAuthenticationSession` needs none of that. It takes itself away when the callback scheme
matches and reports a cancel as error code 1, so the completion handler is the whole of it. What it
does need is to be retained: a session nothing holds deallocates and then never calls back, which
is the classic way to lose an afternoon to that API, and its presentation context provider is held
weakly so it goes the same way. Both are kept in `browser.rs` until the next attempt replaces them,
rather than being released inside the completion handler that the session itself owns.

One thing the Rust side cannot do anything about: a cancel still reaches the accounts panel as a
failed connect, because `AuthEvent` has no third shape, so it reads as "Sign-in was cancelled."
under a toast rather than as nothing at all.

## Toolchain

iOS needs Xcode and the iOS Rust targets:

```
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

Android needs the SDK, an NDK of r25 or newer, a JDK that the generated Gradle build accepts (21
works, 25 does not), and the four Android Rust targets:

```
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
```

## Building

```
pnpm tauri ios init          # once, generates the Xcode project
pnpm tauri ios dev           # simulator, with the Vite dev server
pnpm tauri ios build

pnpm tauri android init      # once, generates the Gradle project
pnpm tauri android dev       # emulator or attached device
pnpm tauri android build
```

The generated projects are committed, and three files in the Android one are edited by hand.
`MainActivity.kt` publishes the window insets and launches the consent tab, `app/build.gradle.kts`
carries the `androidx.browser` dependency the tab needs, and `AndroidManifest.xml` carries a
`<queries>` element without which Android 11 and up hide every browser from
`CustomTabsClient.getPackageName` and the consent page quietly falls back to a separate browser
app. Re-running `android init` overwrites all three and nothing else supplies any of them, so check
for them afterwards: without the insets the bars overlap the page, and without the bridge tapping
Connect opens nothing at all.

Both `dev` commands start Vite themselves and fail outright if port 1430 is already taken, which
it will be if a browser dev server is still up. Kill it, or pass a different port through
`--config`.

Three failures that look like bugs and are not. Xcode refusing to build with "Entitlements file
was modified during the build" is a stale mtime in DerivedData, fixed once by deleting
`~/Library/Developer/Xcode/DerivedData/margin-calendar-*`. An Android run panicking with "failed
to build WebSocket client, Connection refused" is a stale
`$TMPDIR/studio.margin.calendar-server-addr` pointing at a dead port; delete it. And an emulator
that will not boot by name usually means `avdmanager` and `emulator` disagree about where AVDs
live, which `ANDROID_AVD_HOME` settles.

Finally, an empty calendar on a device is correct. The browser fixture is gated on not being
inside Tauri, so on a phone the real backend answers and there is nothing to show until an account
is connected. Events without signing in only ever happen in a browser.

## What is different on a phone

The desktop header carries three groups of controls across one row, which does not fit in 390
points. Under `data-phone` it becomes a top bar with the date and the day arrows and a bottom tab
bar with the views, and everything the trailing icon row used to hold moves into an overflow
sheet. Overlays become bottom sheets. Both bars pad themselves out of the way of the notch and the
home indicator with `env(safe-area-inset-*)`.

Under `data-touch`, which a tablet gets and a narrow desktop window does not, interaction changes
rather than layout. Anything that only appeared on hover is always visible instead, because a
finger cannot hover. Dragging out a new event waits for a long press, because on a touchscreen the
alternative is that every tap on an empty afternoon starts creating something.

Navigation still moves one day at a time. A swipe is one day, not one week.

Both attributes are also set by the boot script in `index.html` before first paint, so a phone
does not render the desktop layout for a frame and then jump.

## Keeping out from under the system bars

`--safe-top` and `--safe-bottom` are `env(safe-area-inset-*)` by default, which is correct on iOS
and wrong on Android in a way that is easy to miss. Android's WebView derives those values from the
display cutout alone and never from the system bars, so it reports 0 at the bottom while the
navigation bar really occupies 24dp of gesture pill or 48dp of buttons, and the tab bar renders
underneath it. `targetSdk` is 36, so edge-to-edge is mandatory and there is nothing to opt out of.
The top only looked right on a test device by luck, because that device had a cutout; a phone
without one would have tucked the top bar under the status bar for the same reason.

So Android measures the bars natively. `MainActivity.kt` reads `systemBars() or displayCutout()`
from `WindowInsetsCompat`, exposes them over a JavaScript bridge, and re-fires on every inset
change, which covers rotation, the keyboard, and switching between gesture and button navigation
live. `src/safeArea.ts` converts device pixels to CSS pixels and writes the two variables onto the
root, where they beat the `env()` defaults. Off Android the bridge is simply absent and the
defaults stand, so iOS and desktop are untouched.

Two consequences worth knowing. `tauri android init` regenerates `MainActivity.kt`, and nothing
else on Android supplies these values, so check the bridge is still there after re-running it.
And installing the inset listener makes `env(safe-area-inset-*)` read 0 inside that WebView, which
does not matter only because those two token lines are the sole consumers and the bridge overrides
both with better numbers. Anything new that reaches for `env()` directly on Android will get zero.

iOS needed one line of native code for the same class of problem, in the opposite direction.

UIKit hands a scroll view the safe areas as content insets unless told otherwise, and wry never
tells it otherwise: it touches the scroll view only to switch `bounces` off. WebKit then lays the
page out in what is left. On an iPhone 17 Pro that meant a layout viewport 778pt tall against an
874pt screen, still anchored at y 0, so the bottom 96pt of the display was outside the page
altogether and showed as a dead band of shell colour under the tab bar. `body` is
`position: fixed`, so nothing could paint down there whatever the stylesheet said.

`stop_uikit_shrinking_the_viewport` in `lib.rs` sets `contentInsetAdjustmentBehavior` to `never`
through `with_webview`, which gives the page the whole screen back. The insets are not lost, they
arrive as `env(safe-area-inset-*)` instead, which is where both bars already read them from.

Worth knowing before anyone tries to solve that in CSS, because it looks like a CSS problem and
the obvious fix is worse than the bug. While the viewport was short, `100dvh` was the only unit
reporting the real box; `vh`, `svh` and `lvh` all reported the full screen. Sizing the root
`100svh` therefore did not reclaim the bottom of the screen, it laid the tab bar out past the clip
where it was invisible and, less obviously, untappable. The root is `height: 100%`, which inherits
whatever the box is and cannot drift if the native line ever regresses.

## Limits worth knowing

There is no auto-updater and no process restart on mobile: the store is the update channel, and
both plugins are compiled out rather than merely hidden.

The initial sync pulls the whole calendar history, because Google forbids `timeMin` alongside a
`syncToken`. That is already the desktop behaviour and it is slower on a phone radio.
