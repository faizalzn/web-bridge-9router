# web-bridge-9router

**English** · [Bahasa Indonesia](#bahasa-indonesia)

A lightweight local gateway that turns web-based LLM chats (Gemini, Claude, ChatGPT and more) into
**OpenAI-compatible** and **Anthropic-compatible** API endpoints, so you can add them to
[9router](https://github.com/decolua/9router) as a custom provider and use your existing plan
(including free plans) instead of paying for API access.

> **Status:** Sprint 4 of 8. The API server, provider login, the **Gemini adapter** and **emulated tool calling** work.
> Claude and ChatGPT adapters and the GUI are coming next. See [Known limitations](#known-limitations).

## ⚠️ Disclaimer

This tool automates consumer web apps, and most AI providers' Terms of Service forbid that.
It is built to look like normal personal use (one queue per account, real browser login, no always-on
headless browser), but **it cannot guarantee that your account will not be rate-limited or banned**.
Use it with your own accounts, for personal use, at a reasonable volume. You use it at your own risk.

## Requirements

- Node.js 20+ (Node 22.18+ can run the TypeScript sources directly)
- A Chromium-based browser: Microsoft Edge, Google Chrome, Chromium, Brave or Vivaldi, on Windows, macOS or Linux
  (see [Choosing a browser](#choosing-a-browser)). Firefox and Safari are not supported.

## Quick start

```bash
npm install
npm run build
npm test                  # optional: runs the offline tests
node dist/cli.js init      # creates config.yaml with a random API key
node dist/cli.js start
```

## Log in to a provider

```bash
node dist/cli.js login gemini     # or: claude, chatgpt
```

A normal Edge/Chrome window opens (using a separate profile in `data/`, never your own one).
Log in as usual; the login is detected automatically. The session is saved **encrypted** in
`data/sessions/` and the browser is **closed completely**, so it uses no RAM afterwards.

If a site refuses to log in inside that window, export your cookies from your normal browser
(for example with the Cookie-Editor extension, "Export → JSON") and import them:

```bash
node dist/cli.js login gemini --import cookies.json --user-agent "<your browser's User-Agent>"
```

Already logged in? `login` tells you so instead of opening the browser. Use `--force` to log in again
(for example with another Google user), or `--account <name>` to add more accounts:

```bash
node dist/cli.js login gemini --force            # log in again
node dist/cli.js login gemini --account work     # add a second account
```

Other session commands: `sessions` (list, with the result of the last real check), `check <provider> [--account name]`
(asks the provider whether the saved login still works), `logout <provider> [--account name]`.

Choose how long a login is kept with `--keep 1d | 3d | 7d | 30d | forever` (default `forever`, or `session.retention`
in `config.yaml`). A login older than that is deleted automatically.

### Several accounts at once

Each provider can hold more than one login at the same time. Give every extra login a name with `--account`:

```bash
node dist/cli.js login claude                     # the "default" account
node dist/cli.js login claude --account work      # a second account, its own browser profile
```

Both stay online together: each account keeps its own browser profile (`data/profiles/<provider>-<account>`), its
own request queue (so a slow request on one does not block the other), and its own keep-alive. Address an extra
account in the model id with `@`:

```
claude/sonnet          # the default account
claude@work/sonnet     # the "work" account
```

`bridge sessions` lists every account and its state. This is the way around a single account's usage limit: put a
second login behind another model id and point some clients at it.

### Choosing a browser

The gateway drives a browser that is already installed. `bridge browsers` lists what it found and which one it uses.

```yaml
browser:
  channel: auto        # auto | msedge | chrome | chromium | brave | vivaldi
  executable_path: ""  # or the full path of any other Chromium-based browser (wins over channel)
```

`auto` looks in the usual install locations and picks, in this order: Edge, Chrome, Brave, Vivaldi, Chromium on
Windows; Chrome, Edge, Brave, Vivaldi, Chromium on macOS (`/Applications` and `~/Applications`); Chrome, Edge,
Chromium, Brave, Vivaldi on Linux (`/opt/...` and the names on `PATH`, such as `chromium-browser` or `brave-browser`).

A login profile only works with the browser that made it: on Windows and macOS its cookies are encrypted with a key
that belongs to that browser. The gateway records the browser in the profile (`web-bridge-browser.json`). If
`config.yaml` later chooses another browser, it stops with a clear message instead of silently losing the login: set
the browser back, or log in again with `--force`.

Firefox and Safari are not supported: Playwright can only drive its own patched builds of them, not the copies
installed on the computer. Chromium from a Linux snap may not be able to write a profile outside your home folder;
keep `data_dir` inside your home folder, or use the `.deb`/`.rpm` package of the browser.

### Keeping the login alive

Providers rotate their short-lived cookies, so a saved login that nobody refreshes stops working after a while
(in our tests, within a couple of hours). While `bridge start` is running it refreshes every saved login in the
background (`session.keep_alive`, every 9 minutes) and whenever a browser mode is used. If a login was rejected
anyway, `bridge sessions` shows `EXPIRED` and `bridge login <provider> --force` fixes it.

**Logins held by their own browser (default, `session.hold_in_browser: true`).** A copy of Google's cookies used over
plain HTTP was dropped by Google about two hours after login, three times in a row, even with the cookies rotated every
9 minutes. So `bridge login` now gives each account its own browser profile (`data/profiles/<provider>-<account>`), and
that profile keeps the login, like a normal browser you close and reopen. The gateway reopens it in the background (no
window) for every request (mode B) and for every keep-alive pass, which loads the Gemini page for a few seconds and
checks that it still shows you as logged in. Plain HTTP (mode A) is never used for such a login. Costs: a browser
starts for a request when none is open (it started in under 1 s in our test), and it uses the RAM of one browser while
open; it closes after `browser.idle_timeout` without work.
If Google logs out the headless browser, set `browser.held_headless: false` (an off-screen window instead).
Logins made before this change keep the old behaviour until you log in again.

- Run **one gateway per `data_dir`**. A second one is refused: two processes refreshing the same login overwrite each
  other and Google then rejects it.
- **Stop the gateway before `bridge login`** for a held login; the login refuses to run while a gateway is running.
- Do not use the saved login from other tools at the same time.

> Keep the `data/` folder private: it contains your logged-in sessions.

## Connect to 9router

Add a custom provider in 9router:

| Field | OpenAI-compatible | Anthropic-compatible |
|---|---|---|
| Base URL | `http://127.0.0.1:8787/v1` | `http://127.0.0.1:8787` |
| API key | the `api_key` from `config.yaml` | the same |
| Model | e.g. `gemini/flash-lite`, `gemini/pro`, `claude/sonnet` | the same |

The base URL works with or without `/v1`. Run `bridge models` to list the model ids. Clients that do not allow `/`
in a model name can use `-` instead: `claude-sonnet` means `claude/sonnet`. The same endpoint also works in
any other tool that accepts a custom OpenAI or Anthropic base URL (VS Code extensions, Open WebUI, SDKs, ...).

## Gemini

Uses the Gemini web app with the login from `bridge login gemini`. Models of a Google account (the list matches
what the account sees in the web app):

| Model id | Gemini model |
|---|---|
| `gemini/flash-lite` | 3.5 Flash-Lite (fastest) |
| `gemini/flash` | 3.8 Flash: **not available** (see Known limitations); requests get HTTP 503 at once |
| `gemini/pro` | 3.1 Pro |
| `gemini/argon` | 4 Argon (complex tasks, can take a long time to answer) |

Which models you can use depends on your Google plan. More accounts: `bridge login gemini --account work`, then
use `gemini@work/pro`.

How it works, lightest first (`providers.gemini.mode: auto` picks and switches by itself):

| Mode | What it does | Browser |
|---|---|---|
| **A** | Plain HTTP request with your saved cookies | not needed |
| **B** | The same request sent from inside a real Gemini page | started on demand, closed when idle |
| **C** | Types into the web page and reads the answer | started on demand, closed when idle |

If a mode stops working (the web app changed), the request is answered by the next mode and the next requests
keep using it; the lighter mode is tried again every 10 minutes. `bridge status` shows the active mode.

- **Chats:** 9router resends the whole history each time. When it only grew, the same Gemini chat is continued and
  only the new message is sent; otherwise a new chat starts with the history folded into the prompt
  (`reuse_chats`). Requests create chats in your Gemini history; `auto_delete_chats: true` removes them again.
- **Queue:** one request at a time per account, with a short pause between them (`min_interval`, `jitter`).
- **Tools:** a web chat has no tool API, so the gateway emulates it. When a request has `tools`, it tells the model in the prompt how to write a call (`<tool_call>{...}</tool_call>`), reads the call from the reply and returns it as a normal `tool_calls` / `tool_use` answer. Results sent back by the client continue the same web chat, and only the result is sent. See the limits below.
- **Slow answers:** a web chat can need a minute before its first word. After 20 s without one, the gateway opens the stream anyway and sends an SSE comment (`: keep-alive`) every 15 s, because some clients (9router waits 60 s for the response headers) otherwise give up and send the same request again. An error that happens earlier is answered with a normal HTTP status; a later one arrives as an error event inside the stream. Every request is logged with where its time went (waiting, first reply, total, new or continued chat).
- In modes A and B the model is chosen per request and your account's saved model is not touched. Mode C changes the model picker of your account while it works and puts it back afterwards.

## Claude

```bash
node dist/cli.js login claude
```

Then set `providers.claude.enabled: true`. Models: `claude/sonnet` (default), `claude/opus`, `claude/haiku`.
Only Sonnet 5.5 has been seen on the wire so far; the other two use the same naming and are not tested yet (a plan
without access to one should get an HTTP 400 error; not seen yet).

- Mode B only: the request is sent from inside a claude.ai page in the account's own browser profile, so the login
  must be held by that profile (`session.hold_in_browser: true`, the default). claude.ai sits behind Cloudflare, so
  there is no plain-HTTP mode. If Cloudflare shows a bot check, the request fails with HTTP 503; the gateway does not
  try to get past it. Claude requests for that account are then paused (10 min, doubling up to 1 h while the check
  keeps coming back; `bot_check_pause` in seconds) and answered with 503 at once, instead of opening claude.ai again
  for every retry of 9router or Hermes. On 11 Nov 2026 this happened after about 35 requests in one hour through
  Hermes; how long such a check lasts is not known yet.
- No connector or server tools of the account (documents, web search, widgets) are sent, so the model cannot act on
  the account by itself. Tool calling for clients such as Hermes is emulated by the gateway, as for Gemini.
- 9router's growing history continues the same claude.ai chat (only the new message is sent).
- The quota claude.ai reports after each answer is logged (`quota used 5h 7% / 7d 0%`) and shown by `bridge status`.
  When the usage limit is reached, requests fail with HTTP 429.
- `effort` (`low | medium | high | extra | default`, default `medium`) sets the account-wide default reasoning
  effort. A caller can also choose per request with a model suffix: `claude/opus:high`, `claude/opus:extra`,
  or `claude/opus:auto` (send no effort, let Claude decide). `claude/opus` alone uses the configured default.
  The suffix forms are not listed in `/v1/models` but are accepted. (`extra` exists on Pro/Max; its exact
  wire value is not yet confirmed against the live page.)
- Not there yet: deleting the chats the gateway creates, a keep-alive visit for Claude logins, attachments.

## ChatGPT

```bash
node dist/cli.js login chatgpt
```

Then set `providers.chatgpt.enabled: true`. One model: `chatgpt/auto` (whatever model the web app is set to).

- **Mode C only (the page is typed into, not called).** chatgpt.com protects its message endpoint with a
  page-generated proof-of-work (the "sentinel" challenge) on top of Cloudflare. The gateway will **not** forge that
  token, so there is no request mode: instead the prompt is typed into the real composer and the answer is read from
  the page, exactly as a person does. The page computes its own proof-of-work legitimately.
- Needs the login held by its browser profile (`session.hold_in_browser: true`, the default).
- Every request is a fresh chat (no continuation), and it is slower than a request-based mode.
- If Cloudflare shows a bot check, the request fails with 503 and the account is paused (10 min, doubling up to 1 h;
  `bot_check_pause`), like Claude. The gateway does not try to get past the check.
- Picking a specific model, continuing a chat, and attachments are not there yet.

## Known limitations

- Tool calling is emulated in text, so it is less reliable than a real API. Two measurements with the Argon model: in a small isolated test with a bare prompt (six prompts, one try each, repeated a few times) the model answered with a valid call for roughly half to two thirds of the requests that needed one; in real use through Hermes, 12 simple task prompts (list a folder, create, read and edit a file, run a command, search the web) were all completed. When the model skips a call it describes the action or pastes code instead, and the client sees a plain text answer; asking again usually helps. Both samples are small, the tasks were simple, and Flash and Pro were not measured.
- Whatever the model writes after a tool call is dropped (it would be a guess of the result). A call with invalid JSON or an unknown tool name is shown as text and never executed.
- Images and files in a request are ignored. `max_tokens` and `temperature` cannot be set on a web chat.
- Token counts are estimates (web chats do not report them).
- Gemini replies are plain text/Markdown; cards, images and canvases are dropped.
- Sometimes the Gemini web app fails internally and answers with a canned message such as "Sorry, something went wrong. Please try your request again." The gateway turns the messages seen so far into an HTTP 502 error (so 9router can fall back) instead of passing them on as an answer. On 10 Nov 2026 the Flash model answered every request this way, even a plain "hey chat", over plain HTTP, from a page (mode B) and by typing into the page (mode C), while a person typing in the same browser profile got normal answers and Flash-Lite and Argon kept working. The web app now sends Flash messages over a new channel together with an attestation token generated by Google's anti-abuse script in the page. The gateway does not try to get past that check, so `gemini/flash` is marked unavailable: it is left out of `/v1/models` and requests fail at once with HTTP 503 (9router can fall back). Gemini's internal error code 13 is reported the same way and no longer makes the gateway switch transport. Each reply is logged as `reply <model>: text N chars, tool calls: ...`; with `log_level: debug` the reply itself is logged too.
- Login lifetime: a cookie copy used over plain HTTP died about 2 hours after login in all three tries. The first held login (10 Nov 2026) was still verified 5 h 18 min after login (also after a gateway restart), and in the browser `__Secure-1PSIDTS` was renewed about every 19 minutes, which plain HTTP rotation never did. That is one run; how long a held login lasts is not known yet. If `bridge sessions` shows `EXPIRED`, log in again. `auto_delete_chats` is skipped for held logins (deleting goes over plain HTTP).

## Endpoints

| Method | Path | Format |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions, streaming and non-streaming |
| POST | `/v1/responses` | OpenAI Responses API, streaming, tools and `previous_response_id` (kept in memory, last 200) |
| POST | `/v1/messages` | Anthropic, streaming and non-streaming |
| POST | `/v1/messages/count_tokens` | Anthropic (estimated) |
| GET | `/v1/models` | OpenAI, or Anthropic when the `anthropic-version` header is sent |
| GET | `/health` | Gateway and provider status |

## CLI

```
bridge init | start | status | models | version
bridge login <provider> [--account name] [--force] [--keep 7d] [--import file]
bridge logout <provider> [--account name] | sessions | check <provider> [--account name]
bridge browsers                                 browsers found and the one in use
bridge update                                   (Sprint 6)
bridge gui install | uninstall                  (Sprint 7)
```

## Roadmap

1. ✅ Core server, CLI, config, OpenAI and Anthropic endpoints, echo provider
2. ✅ Browser login with real Edge/Chrome, encrypted cookie store, lazy browser
3. 🟡 Gemini adapter (modes A, B and C), automatic mode switching, conversation cache. Working; long-term
   session durability and chat deletion still need a clean multi-hour verification.
4. 🟡 Emulated tool calling. Working and tested with a mock provider and live on Gemini; reliability depends on the model (see Known limitations).
5. 🟡 Claude adapter (claude.ai, mode B) and ChatGPT adapter (chatgpt.com, mode C): first real answers 10–11 Nov
   2026. Simultaneous multi-account. Choice of browser on Windows, macOS and Linux.
6. Automatic manifest updates and app update notices
7. Optional web GUI, downloaded from GitHub Releases
8. More providers and full documentation

---

## Bahasa Indonesia

[English](#web-bridge-9router) · **Bahasa Indonesia**

Gateway lokal yang ringan untuk menjadikan web chat LLM (Gemini, Claude, ChatGPT, dan lainnya) sebagai
endpoint API yang **kompatibel dengan OpenAI** dan **Anthropic**. Dengan begitu, web chat tersebut bisa
ditambahkan ke [9router](https://github.com/decolua/9router) sebagai custom provider, dan Anda bisa memakai
langganan yang sudah dimiliki (termasuk paket gratis) tanpa membayar akses API.

> **Status:** Sprint 4 dari 8. Server API, login provider, **adapter Gemini**, dan **tool calling tiruan** sudah berfungsi.
> Adapter Claude dan ChatGPT serta GUI menyusul. Lihat [Keterbatasan](#keterbatasan).

## ⚠️ Peringatan

Alat ini mengotomatiskan aplikasi web konsumen, dan ToS sebagian besar provider AI melarang hal itu.
Alat ini dirancang agar terlihat seperti pemakaian pribadi biasa (satu antrean per akun, login lewat
browser asli, tidak ada browser headless yang terus menyala), tetapi **tidak ada jaminan akun Anda tidak
terkena rate limit atau ban**. Gunakan dengan akun sendiri, untuk keperluan pribadi, dan dalam jumlah
wajar. Risiko pemakaian ditanggung sendiri.

## Kebutuhan

- Node.js 20+ (Node 22.18+ bisa langsung menjalankan source TypeScript)
- Browser berbasis Chromium: Microsoft Edge, Google Chrome, Chromium, Brave, atau Vivaldi, di Windows, macOS,
  atau Linux (lihat [Memilih browser](#memilih-browser)). Firefox dan Safari tidak didukung.

## Mulai cepat

```bash
npm install
npm run build
npm test                  # opsional: menjalankan tes offline
node dist/cli.js init      # membuat config.yaml dengan API key acak
node dist/cli.js start
```

## Login ke provider

```bash
node dist/cli.js login gemini     # atau: claude, chatgpt
```

Jendela Edge atau Chrome biasa akan terbuka. Jendela ini memakai profil terpisah di `data/`, bukan profil
browser Anda sendiri. Login seperti biasa, dan login akan terdeteksi otomatis. Sesi disimpan **terenkripsi**
di `data/sessions/`, lalu browser **ditutup total** sehingga tidak memakai RAM lagi.

Kalau situs menolak login di jendela tersebut, ekspor cookie dari browser yang biasa Anda pakai (misalnya
dengan ekstensi Cookie-Editor, "Export → JSON"), lalu impor:

```bash
node dist/cli.js login gemini --import cookies.json --user-agent "<User-Agent browser Anda>"
```

Kalau sudah login, `login` akan memberi tahu hal itu dan tidak membuka browser. Pakai `--force` untuk login
ulang (misalnya dengan akun Google lain), atau `--account <nama>` untuk menambah akun:

```bash
node dist/cli.js login gemini --force            # login ulang
node dist/cli.js login gemini --account kerja    # tambah akun kedua
```

Perintah sesi lainnya: `sessions` (daftar sesi beserta hasil pengecekan nyata terakhir), `check <provider> [--account nama]`
(menanyakan ke provider apakah login yang tersimpan masih berfungsi), `logout <provider> [--account nama]`.

Atur berapa lama login disimpan dengan `--keep 1d | 3d | 7d | 30d | forever` (default `forever`, atau `session.retention`
di `config.yaml`). Login yang lebih tua dari itu dihapus otomatis.

### Beberapa akun sekaligus

Tiap provider bisa memegang lebih dari satu login sekaligus. Beri nama tiap login tambahan dengan `--account`:

```bash
node dist/cli.js login claude                     # akun "default"
node dist/cli.js login claude --account work      # akun kedua, profil browser sendiri
```

Keduanya tetap online bersamaan: tiap akun punya profil browser sendiri (`data/profiles/<provider>-<account>`),
antrean request sendiri (jadi request lambat di satu akun tidak menahan yang lain), dan keep-alive sendiri. Sebut
akun tambahan di nama model dengan `@`:

```
claude/sonnet          # akun default
claude@work/sonnet     # akun "work"
```

`bridge sessions` menampilkan tiap akun dan statusnya. Ini cara menyiasati batas pemakaian satu akun: taruh login
kedua di belakang nama model lain, lalu arahkan sebagian klien ke sana.

### Memilih browser

Gateway memakai browser yang sudah terpasang. `bridge browsers` menampilkan browser yang ditemukan dan browser mana
yang dipakai.

```yaml
browser:
  channel: auto        # auto | msedge | chrome | chromium | brave | vivaldi
  executable_path: ""  # atau path lengkap browser berbasis Chromium lain (mengalahkan channel)
```

`auto` mencari di lokasi pemasangan yang umum dan memilih dengan urutan: Edge, Chrome, Brave, Vivaldi, Chromium di
Windows; Chrome, Edge, Brave, Vivaldi, Chromium di macOS (`/Applications` dan `~/Applications`); Chrome, Edge,
Chromium, Brave, Vivaldi di Linux (`/opt/...` dan nama di `PATH`, seperti `chromium-browser` atau `brave-browser`).

Profil login hanya bisa dipakai oleh browser yang membuatnya: di Windows dan macOS cookie-nya dienkripsi dengan
kunci milik browser itu. Gateway mencatat browser tersebut di dalam profil (`web-bridge-browser.json`). Kalau
`config.yaml` kemudian memilih browser lain, gateway berhenti dengan pesan yang jelas, bukan diam-diam kehilangan
login: kembalikan pilihan browser, atau login ulang dengan `--force`.

Firefox dan Safari tidak didukung: Playwright hanya bisa mengendalikan versi khusus miliknya sendiri, bukan yang
terpasang di komputer. Chromium dari snap di Linux mungkin tidak bisa menulis profil di luar folder home; simpan
`data_dir` di dalam folder home, atau pakai paket `.deb`/`.rpm` browser tersebut.

### Menjaga login tetap hidup

Provider terus merotasi cookie jangka pendeknya, jadi login tersimpan yang tidak diperbarui akan berhenti berfungsi
setelah beberapa waktu (dalam uji kami, dalam hitungan jam). Selama `bridge start` berjalan, semua login tersimpan
diperbarui di latar belakang (`session.keep_alive`, tiap 9 menit) dan setiap kali mode browser dipakai. Kalau sebuah
login tetap ditolak, `bridge sessions` menampilkan `EXPIRED` dan `bridge login <provider> --force` memperbaikinya.

**Login dipegang browsernya sendiri (default, `session.hold_in_browser: true`).** Salinan cookie Google yang dipakai lewat
HTTP biasa dibuang Google sekitar dua jam setelah login, tiga kali berturut-turut, walaupun cookie dirotasi tiap 9 menit.
Karena itu `bridge login` sekarang memberi tiap akun profil browser sendiri (`data/profiles/<provider>-<akun>`), dan profil
itulah yang menyimpan login, seperti browser biasa yang ditutup lalu dibuka lagi. Gateway membuka profil itu di latar
belakang (tanpa jendela) untuk setiap request (mode B) dan setiap putaran keep-alive, yang memuat halaman Gemini beberapa
detik lalu memeriksa bahwa Anda masih tampil login. HTTP biasa (mode A) tidak pernah dipakai untuk login seperti ini.
Biayanya: browser dinyalakan untuk request bila belum terbuka (di uji kami kurang dari 1 detik), dan memakai RAM satu
browser selama terbuka; browser ditutup setelah `browser.idle_timeout` tanpa pekerjaan. Bila Google mengeluarkan browser headless, pasang `browser.held_headless: false` (jendela
di luar layar). Login yang dibuat sebelum perubahan ini tetap memakai cara lama sampai Anda login ulang.

- Jalankan **satu gateway per `data_dir`**. Gateway kedua ditolak: dua proses yang memperbarui login yang sama saling
  menimpa dan Google lalu menolaknya.
- **Hentikan gateway sebelum `bridge login`** untuk login yang dipegang browser; login menolak berjalan selama gateway hidup.
- Jangan memakai login tersimpan itu dari alat lain pada saat yang sama.

> Jaga folder `data/` tetap privat, karena isinya sesi akun Anda yang sedang login.

## Menghubungkan ke 9router

Tambahkan custom provider di 9router:

| Kolom | Kompatibel OpenAI | Kompatibel Anthropic |
|---|---|---|
| Base URL | `http://127.0.0.1:8787/v1` | `http://127.0.0.1:8787` |
| API key | `api_key` dari `config.yaml` | sama |
| Model | misalnya `gemini/flash-lite`, `gemini/pro`, `claude/sonnet` | sama |

Base URL bisa ditulis dengan atau tanpa `/v1`. Jalankan `bridge models` untuk melihat daftar model. Klien yang tidak
mengizinkan `/` di nama model boleh memakai `-`: `claude-sonnet` berarti `claude/sonnet`. Endpoint yang sama
juga bisa dipakai di alat lain yang menerima base URL OpenAI atau Anthropic kustom (ekstensi VS Code, Open WebUI, SDK, dan lain-lain).

## Gemini

Memakai aplikasi web Gemini dengan login dari `bridge login gemini`. Model akun Google (daftarnya mengikuti yang
terlihat di aplikasi web untuk akun itu):

| ID model | Model Gemini |
|---|---|
| `gemini/flash-lite` | 3.5 Flash-Lite (tercepat) |
| `gemini/flash` | 3.8 Flash: **tidak tersedia** (lihat Keterbatasan); request langsung mendapat HTTP 503 |
| `gemini/pro` | 3.1 Pro |
| `gemini/argon` | 4 Argon (tugas kompleks, bisa lama menjawab) |

Model apa saja yang bisa dipakai bergantung pada paket Google Anda. Akun tambahan: `bridge login gemini --account kerja`,
lalu pakai `gemini@kerja/pro`.

Cara kerja, dari yang teringan (`providers.gemini.mode: auto` memilih dan berpindah sendiri):

| Mode | Yang dilakukan | Browser |
|---|---|---|
| **A** | Request HTTP biasa dengan cookie tersimpan | tidak perlu |
| **B** | Request yang sama, dikirim dari dalam halaman Gemini asli | dinyalakan saat perlu, ditutup saat idle |
| **C** | Mengetik di halaman web dan membaca jawabannya | dinyalakan saat perlu, ditutup saat idle |

Kalau satu mode berhenti bekerja (aplikasi web berubah), request dijawab oleh mode berikutnya dan request selanjutnya
tetap memakainya; mode yang lebih ringan dicoba lagi tiap 10 menit. `bridge status` menampilkan mode yang aktif.

- **Chat:** 9router mengirim ulang seluruh riwayat setiap kali. Kalau riwayat hanya bertambah, chat Gemini yang sama
  dilanjutkan dan hanya pesan baru yang dikirim; selain itu chat baru dimulai dengan riwayat dilipat ke dalam prompt
  (`reuse_chats`). Request membuat chat di riwayat Gemini Anda; `auto_delete_chats: true` menghapusnya kembali.
- **Antrean:** satu request pada satu waktu per akun, dengan jeda singkat di antaranya (`min_interval`, `jitter`).
- **Tool:** web chat tidak punya API tool, jadi gateway menirunya. Bila request berisi `tools`, gateway memberi tahu model lewat prompt cara menulis panggilan (`<tool_call>{...}</tool_call>`), membaca panggilan itu dari balasan, lalu mengembalikannya sebagai jawaban `tool_calls` / `tool_use` biasa. Hasil yang dikirim balik klien melanjutkan web chat yang sama, dan hanya hasilnya yang dikirim. Lihat batasannya di bawah.
- **Jawaban lambat:** web chat bisa butuh semenit sebelum kata pertama. Setelah 20 detik tanpa kata pertama, gateway tetap membuka stream dan mengirim komentar SSE (`: keep-alive`) tiap 15 detik, karena sebagian klien (9router menunggu header respons 60 detik) kalau tidak akan menyerah lalu mengirim ulang request yang sama. Error yang terjadi lebih awal dijawab dengan status HTTP biasa; yang terjadi kemudian datang sebagai event error di dalam stream. Setiap request dicatat di log beserta rincian waktunya (menunggu, balasan pertama, total, chat baru atau lanjutan).
- Di mode A dan B model dipilih per request dan pilihan model tersimpan di akun Anda tidak disentuh. Mode C mengubah pemilih model akun Anda selama bekerja, lalu mengembalikannya.

## Claude

```bash
node dist/cli.js login claude
```

Lalu isi `providers.claude.enabled: true`. Model: `claude/sonnet` (bawaan), `claude/opus`, `claude/haiku`. Baru
Sonnet 5.5 yang terlihat di lalu lintas halaman; dua lainnya memakai pola nama yang sama dan belum diuji (paket yang
tidak punya akses ke model itu seharusnya mendapat galat HTTP 400; belum pernah terlihat).

- Hanya mode B: request dikirim dari dalam halaman claude.ai di profil browser akun itu sendiri, jadi login harus
  dipegang profil tersebut (`session.hold_in_browser: true`, bawaan). claude.ai dilindungi Cloudflare, jadi tidak ada
  mode HTTP biasa. Kalau Cloudflare menampilkan pemeriksaan bot, request gagal dengan HTTP 503; gateway tidak mencoba
  melewatinya. Request Claude untuk akun itu lalu dijeda (10 menit, berlipat sampai 1 jam selama pemeriksaan terus
  muncul; `bot_check_pause` dalam detik) dan langsung dijawab 503, bukan membuka claude.ai lagi untuk setiap percobaan
  ulang dari 9router atau Hermes. Pada 11 Nov 2026 ini terjadi setelah sekitar 35 request dalam satu jam lewat Hermes;
  berapa lama pemeriksaan seperti itu bertahan belum diketahui.
- Connector dan tool server milik akun (dokumen, pencarian web, widget) tidak dikirim, jadi model tidak bisa bertindak
  atas akun dengan sendirinya. Tool calling untuk klien seperti Hermes ditiru oleh gateway, sama seperti Gemini.
- Riwayat dari 9router yang terus bertambah melanjutkan chat claude.ai yang sama (hanya pesan baru yang dikirim).
- Kuota yang dilaporkan claude.ai setelah tiap jawaban ditulis di log (`quota used 5h 7% / 7d 0%`) dan ditampilkan
  `bridge status`. Kalau batas pemakaian tercapai, request gagal dengan HTTP 429.
- `effort` (`low | medium | high | extra | default`, bawaan `medium`) menetapkan default penalaran seluruh akun.
  Pemanggil juga bisa memilih per-request lewat akhiran nama model: `claude/opus:high`, `claude/opus:extra`,
  atau `claude/opus:auto` (tidak mengirim effort, biar Claude yang putuskan). `claude/opus` saja memakai default.
  Bentuk berakhiran ini tidak muncul di `/v1/models` tapi tetap diterima. (`extra` ada di Pro/Max; nilai persis
  yang dikirim belum dikonfirmasi ke halaman asli.)
- Belum ada: menghapus chat yang dibuat gateway, kunjungan keep-alive untuk login Claude, lampiran.

## ChatGPT

```bash
node dist/cli.js login chatgpt
```

Lalu isi `providers.chatgpt.enabled: true`. Satu model: `chatgpt/auto` (model apa pun yang sedang dipilih di web).

- **Hanya mode C (halaman diketik, bukan dipanggil).** chatgpt.com melindungi endpoint pesannya dengan
  proof-of-work buatan halaman (tantangan "sentinel") di atas Cloudflare. Gateway **tidak** memalsukan token itu,
  jadi tidak ada mode request: prompt diketik di kotak chat asli dan jawaban dibaca dari halaman, persis seperti
  orang. Halaman menghitung proof-of-work-nya sendiri secara wajar.
- Perlu login yang dipegang profil browser (`session.hold_in_browser: true`, bawaan).
- Tiap request adalah chat baru (tanpa lanjutan), dan lebih lambat daripada mode berbasis request.
- Kalau Cloudflare menampilkan pemeriksaan bot, request gagal 503 dan akun dijeda (10 menit, berlipat sampai 1 jam;
  `bot_check_pause`), seperti Claude. Gateway tidak mencoba melewatinya.
- Memilih model tertentu, melanjutkan chat, dan lampiran belum ada.

## Keterbatasan

- Tool calling ditiru lewat teks, sehingga kurang andal dibanding API sungguhan. Dua pengukuran dengan model Argon: pada uji terisolasi kecil dengan prompt polos (enam prompt, satu percobaan tiap prompt, diulang beberapa kali) model menjawab dengan panggilan valid pada kira-kira separuh sampai dua pertiga request yang membutuhkannya; pada pemakaian nyata lewat Hermes, 12 tugas sederhana (melihat isi folder, membuat, membaca, dan mengubah file, menjalankan perintah, mencari di web) semuanya selesai. Bila model melewatkan panggilan, ia menjelaskan tindakannya atau menempelkan kode, dan klien melihat jawaban teks biasa; meminta ulang biasanya membantu. Kedua sampel kecil, tugasnya sederhana, dan Flash serta Pro belum diukur.
- Apa pun yang ditulis model setelah panggilan tool dibuang (isinya hanya tebakan hasil). Panggilan dengan JSON tidak valid atau nama tool yang tidak dikenal ditampilkan sebagai teks dan tidak pernah dijalankan.
- Gambar dan file dalam request diabaikan. `max_tokens` dan `temperature` tidak bisa diatur pada web chat.
- Jumlah token hanya perkiraan (web chat tidak melaporkannya).
- Jawaban Gemini berupa teks/Markdown; kartu, gambar, dan canvas dibuang.
- Kadang web Gemini gagal di dalam dan menjawab dengan pesan bawaan seperti "Sorry, something went wrong. Please try your request again." Gateway mengubah pesan yang sudah dikenali menjadi galat HTTP 502 (agar 9router bisa fallback), bukan meneruskannya sebagai jawaban. Pada 10 Nov 2026 model Flash menjawab setiap request dengan cara ini, bahkan "hey chat" biasa, lewat HTTP biasa, dari halaman (mode B), maupun dengan mengetik di halaman (mode C), sementara orang yang mengetik sendiri di profil browser yang sama mendapat jawaban normal, dan Flash-Lite serta Argon tetap berjalan. Web Gemini kini mengirim pesan Flash lewat saluran baru bersama token atestasi yang dibuat skrip anti-penyalahgunaan Google di halaman. Gateway tidak mencoba melewati pemeriksaan itu, jadi `gemini/flash` ditandai tidak tersedia: tidak muncul di `/v1/models` dan request langsung gagal dengan HTTP 503 (9router bisa fallback). Galat internal Gemini code 13 dilaporkan dengan cara yang sama dan tidak lagi membuat gateway berganti transport. Setiap jawaban dicatat sebagai `reply <model>: text N chars, tool calls: ...`; dengan `log_level: debug` isi jawabannya ikut dicatat.
- Umur login: salinan cookie yang dipakai lewat HTTP biasa mati sekitar 2 jam setelah login pada ketiga percobaan. Login pertama yang dipegang browser (10 Nov 2026) masih terverifikasi 5 jam 18 menit setelah login (juga setelah gateway dinyalakan ulang), dan di browser `__Secure-1PSIDTS` diperbarui kira-kira tiap 19 menit, hal yang tidak pernah terjadi lewat rotasi HTTP. Itu baru satu kali uji; berapa lama login seperti ini bertahan belum diketahui. Bila `bridge sessions` menampilkan `EXPIRED`, login ulang. `auto_delete_chats` dilewati untuk login yang dipegang browser (penghapusan memakai HTTP biasa).

Daftar endpoint, perintah CLI, dan roadmap sama dengan bagian bahasa Inggris di atas.
