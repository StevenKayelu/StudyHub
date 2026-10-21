# Design note: content protection and downloads

- **Status:** DONE (2026-10-21). Scope addition requested by the product owner before M10 is finished. Decisions 1–5 in §4 were confirmed by the product owner on 2026-10-21; items 6–9 are **PROPOSED** implementation details.
- **Changes the blueprint:** BR-64 had a per-lesson "downloadable" flag that was stored but not enforced. It is now enforced, applies to videos as well as files, and the school decides whether tutors choose.
- **Baseline:** `single-session-wip` commit `71001b2`, branch `content-protection-wip`.

## 1. What the product owner asked for

Restrict downloads and screenshots, and let each school and tutor choose: some want learners to stream and view only, others want learners to download so they use less mobile data.

**What a web app can and can't do:** no website can block screenshots. Learners can always press Print Screen, use their phone's screenshot button or photograph the screen. What a web app can do is deter casual copying and make leaks traceable. Real protection against recording video needs the video provider's DRM (Q-VID: no provider is approved yet). Native mobile apps can block screenshots; this web app can't.

| Question                       | Decision                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Files a learner can't download | **View in the browser only**: PDFs and images open in the page; other files are listed but not available            |
| Screenshot and copy deterrents | **The learner's name and email as a watermark**, and **no copying, right-click or printing** on protected lessons   |
| Who decides                    | **The school**, which can let **each tutor** choose: protection per course, downloads per lesson                    |
| Downloads to save data         | **Both options**: stream and view only, or download (files, and videos where the video service offers a saved copy) |

## 2. Model

- School settings (Admin → Settings → Courses and materials):
  - `contentProtection`: `TUTOR_CHOOSES` (default; courses are protected unless the tutor turns it off), `ALWAYS` or `NEVER`.
  - `downloadPolicy`: `TUTOR_CHOOSES` (default; each lesson's switch decides), `ALWAYS` or `NEVER`.
  - `downloadsAllowedDefault` (existing, now shown): new lessons start with downloads on or off.
- Course `protect_content`: the tutor's choice (null = protected), used only while the school lets tutors choose. Changing it otherwise is refused (`school_decides`).
- Lesson `downloadable` (existing): now covers the lesson's files and its video, and is enforced.
- Rules: `learning/domain/content-policy.ts`. Owners and administrators previewing a course are never limited.

## 3. Behaviour

- **Protected lessons** (`PlayerLesson.protection`): a faint watermark with the learner's name and email over the lesson text, video and file viewer, moving every 20 seconds; no selecting, copying, cutting, dragging or right-click; Ctrl/Cmd + C, X, S, P and U are off; printing shows "This lesson is protected and can't be printed." A visitor on a preview lesson sees the school's name.
- **Stream and view only lessons:** the API refuses download links (`DOWNLOAD_NOT_ALLOWED`, 403). PDFs and images open in the page from a one-minute link, without a download name, with the watermark on top. Other file types (Word, PowerPoint, Excel, ZIP) say "Not available to view online"; tutors should upload PDFs for view-only lessons.
- **Downloadable lessons:** "Download" for files, as before. "Save video to watch offline" appears where the video service offers a saved copy (`VideoProvider.download`). The fake provider keeps no bytes, so the button doesn't appear until a real provider is connected.

## 4. Decisions

Confirmed by the product owner (2026-10-21):

1. Files that aren't downloadable can be viewed in the browser only.
2. A watermark with the learner's name and email on protected content.
3. No copying, right-click or printing on protected content.
4. The school decides, and can let each tutor choose; on by default.
5. Both stream-only and download options, including videos for offline viewing.

Still **PROPOSED** (implementation details):

6. View links last 60 seconds; download links 10 minutes (as before).
7. The watermark shows name and email (not the IP address).
8. In full-screen video the browser hides the page's watermark; it returns with DRM and a provider-side watermark once a provider is approved.
9. No "blur when the window loses focus" and no screenshot-key logging (not chosen: unreliable and annoying for learners).

## 5. Tests

- Unit: `content-policy.test.ts` (protection and download rules, which files a browser can show).
- Integration: `content-protection.int.test.ts` (default: protected with the learner's name, downloads refused, PDF opens view-only, Word can't be viewed, the tutor unlimited; the tutor turns protection off and allows downloads; the school decides for every course and tutors are refused, audited; video saving only where the service offers it). The new routes are in the cross-school sweep (T-ISO-12, T-ISO-22).
- Browser: `content-protection.spec.ts` (watermark with the learner's name, no selection, printing shows only the notice; the tutor's choice in Studio and no watermark when previewing), with axe. The watermark is drawn as an image, so accessibility checks don't read it as low-contrast text.

`pnpm verify` passed on 2026-10-21: 430 unit (API 383, contracts 35, UI 12), 936 integration in 25 files, build, 8 security, 70 isolated e2e, 198 Storybook, OpenAPI, secret scan.
