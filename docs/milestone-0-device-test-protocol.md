# Milestone 0 — Device Test Protocol

Run this checklist by hand before committing to the front-end UX. Each section has a results table you fill in per device.

**Goal:** Know the browser caveats before building the capture and bulk-save UIs.

---

## 1. iOS Safari — Multi-Angle Capture

### What to test
Face enrollment requires multiple frames from different angles. Safari's camera API behavior determines what's possible without a native app.

### Checklist

- [ ] Open the test capture page in Safari on iOS (latest)
- [ ] Grant camera permission when prompted
- [ ] Capture front-camera frame, portrait orientation — confirm preview renders
- [ ] Capture front-camera frame, landscape orientation — confirm no rotation issue (EXIF/CSS)
- [ ] Switch from portrait to landscape mid-session without reloading — does the stream break?
- [ ] Test in a dim room: does auto-exposure adjust, or does the preview lock up?
- [ ] Use the `facingMode: 'user'` constraint — confirm it selects front camera, not rear
- [ ] Try `facingMode: { ideal: 'user' }` as fallback — does it fall back gracefully on older devices?
- [ ] Capture 5 frames in rapid succession — any dropped frames or permission re-prompts?
- [ ] Switch tabs mid-session and return — does the stream resume or require re-permission?

### Known limitations to document
- iOS Safari does not support `ImageCapture` API — you must draw to canvas to extract a frame
- `getUserMedia` is only allowed in secure context (HTTPS or localhost)
- Background tab suspension kills the stream silently

### Screenshots to capture
- [ ] Camera permission prompt (first visit)
- [ ] Camera permission prompt (after PWA install — should be pre-granted)
- [ ] Portrait capture preview
- [ ] Landscape capture preview
- [ ] Any error state when stream is suspended

### Results table

| Device | iOS version | Safari version | Front camera works | Orientation switch OK | Dim light OK | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |

---

## 2. iOS PWA — Install Flow + Camera Access

### What to test
PWA install changes permission semantics. Camera access granted in Safari browser may or may not carry over to the installed PWA.

### Checklist

- [ ] Open site in Safari, tap Share → "Add to Home Screen"
- [ ] Confirm the PWA icon appears on the home screen
- [ ] Launch from home screen (standalone mode)
- [ ] Navigate to the capture page — does it prompt for camera permission again?
- [ ] Grant camera permission inside PWA — note whether it re-prompts on second launch
- [ ] Open Settings → Privacy → Camera — confirm the PWA appears as a separate entry from Safari
- [ ] Test offline behavior: launch PWA with no network — does the shell load?
- [ ] Test the back button: does the PWA's navigation history work, or does the hardware back button exit to home?

### Known limitations to document
- iOS PWA camera permissions are scoped to the PWA, not inherited from Safari
- Users must be on HTTPS — camera will silently fail on HTTP
- Standalone PWAs on iOS do not support `beforeinstallprompt` — install is always manual via Share sheet
- Push notifications require iOS 16.4+ and the PWA must be installed before subscribing

### Screenshots to capture
- [ ] Share sheet with "Add to Home Screen" highlighted
- [ ] PWA launch splash (if any)
- [ ] Camera permission prompt inside PWA (first launch)
- [ ] Settings → Privacy → Camera showing PWA entry

### Results table

| Device | iOS version | Install prompt visible | Camera re-prompt | Permission persists across launches | Notes |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |

---

## 3. Android Chrome — Capture + PWA

### Checklist

- [ ] Open site in Chrome on Android (latest)
- [ ] Grant camera permission when prompted
- [ ] Confirm `getUserMedia` with `facingMode: 'user'` selects front camera
- [ ] Test portrait and landscape — confirm no rotation artifacts
- [ ] Observe Chrome's install banner ("Add to Home Screen") — does it appear automatically?
- [ ] Install PWA via the banner or the three-dot menu
- [ ] Launch installed PWA — confirm camera permission is inherited (Android usually carries it over)
- [ ] Test back navigation inside the PWA — hardware back button should navigate history, not exit
- [ ] Test in a low-light room

### Known differences from iOS
- Android Chrome supports `beforeinstallprompt` — you can show a custom install UI
- `ImageCapture` API is available on Android Chrome — direct frame grab is possible
- Camera permissions granted in Chrome browser usually carry to the installed PWA
- Push notifications work in Android PWA without the 16.4+ restriction

### Screenshots to capture
- [ ] Install banner in Chrome
- [ ] PWA installed confirmation
- [ ] Camera permission prompt in PWA

### Results table

| Device | Android version | Chrome version | Install banner appeared | Camera inherited | Back nav OK | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |

---

## 4. Bulk Save — Behavior at Scale

This is the highest-risk UX path. Each platform handles saving multiple files to the camera roll differently.

### Test matrix

Run each cell and record the result.

#### 4a. Save 10 photos

| Platform | Method | Result | Blocking dialogs? | Time to complete |
|---|---|---|---|---|
| iOS Safari | `<a download>` × 10 | | | |
| iOS Safari | Anchor click loop (50ms delay) | | | |
| iOS PWA | `<a download>` × 10 | | | |
| Android Chrome | `<a download>` × 10 | | | |
| Android Chrome PWA | `<a download>` × 10 | | | |

#### 4b. Save 50 photos

| Platform | Method | Result | Blocking dialogs? | Time to complete |
|---|---|---|---|---|
| iOS Safari | Anchor click loop | | | |
| iOS PWA | Anchor click loop | | | |
| Android Chrome | Anchor click loop | | | |
| Android Chrome PWA | Anchor click loop | | | |

#### 4c. Save 200 photos

| Platform | Method | Result | Blocking dialogs? | Time to complete |
|---|---|---|---|---|
| iOS Safari | Anchor click loop | | | |
| iOS PWA | Anchor click loop | | | |
| Android Chrome | Anchor click loop | | | |
| Android Chrome PWA | Anchor click loop | | | |

### What to look for

- **iOS Safari:** Each `<a download>` click triggers a "Download" confirmation sheet. At high counts this becomes unusable. Note at what count it breaks.
- **iOS PWA:** Behavior may differ from Safari — some reports indicate fewer prompts in standalone mode. Verify.
- **Android Chrome:** Files go to the Downloads folder, not the camera roll. Note whether users discover them.
- **Android PWA:** Same Downloads folder behavior. Test whether the notification that appears is dismissed accidentally.
- **Batch limit:** Note the highest count that completes without the user being forced to tap through dialogs.
- **Fallback:** If individual downloads fail, test a ZIP file download as an alternative. Record whether the user understands they need to unzip.

### Checklist

- [ ] iOS Safari: attempt 10 saves — record dialog count
- [ ] iOS Safari: attempt 50 saves — record where it fails or stalls
- [ ] iOS Safari: attempt 200 saves — record failure mode
- [ ] iOS PWA: repeat all three counts
- [ ] Android Chrome: attempt all three counts — note Downloads folder behavior
- [ ] Android Chrome PWA: repeat all three counts
- [ ] Test ZIP fallback: generate a ZIP of 50 photos, trigger download, record success/failure per platform
- [ ] Note: does the ZIP unzip automatically into the camera roll on iOS, or stay in Files?

---

## 5. Decisions to Make After Running This Protocol

Fill these in after completing the tests:

| Question | Answer |
|---|---|
| Can we rely on direct camera capture in Safari without a native shell? | |
| Does the PWA install flow present a meaningful barrier? | |
| What is the practical bulk-save limit on iOS without triggering dialog fatigue? | |
| Should we default to ZIP download for batches above N photos? N = ? | |
| Does Android Chrome's Downloads folder placement hurt the UX enough to need guidance copy? | |
| Do we need a "save to Files app" step on iOS for large batches? | |

---

## 6. Sign-Off

| Test area | Completed by | Date | Result |
|---|---|---|---|
| iOS Safari capture | | | |
| iOS PWA install + camera | | | |
| Android Chrome capture + PWA | | | |
| Bulk save 10/50/200 — iOS Safari | | | |
| Bulk save 10/50/200 — iOS PWA | | | |
| Bulk save 10/50/200 — Android Chrome | | | |
| ZIP fallback | | | |
