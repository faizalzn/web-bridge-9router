# Security findings / Temuan keamanan

_What each provider's web app does to resist automated use, as observed while building the gateway. The gateway
**respects** these protections: it only drives the real page in the user's own browser profile, and **stops** when a
protection blocks, reporting it. It never forges a token, defeats a challenge, or tunes the browser to evade
detection. This note records where the gateway stops and why — not how to get past anything._

_Apa yang dilakukan tiap provider untuk menahan pemakaian otomatis, berdasarkan pengamatan saat membangun gateway.
Gateway **menghormati** pertahanan ini: hanya menggerakkan halaman asli di profil browser pengguna, dan **berhenti**
saat diblokir, lalu melaporkannya. Tidak pernah memalsukan token, menembus tantangan, atau menyetel browser agar
lolos deteksi. Catatan ini merekam di mana gateway berhenti dan mengapa — bukan cara melewatinya._

Last updated / Terakhir diperbarui: 11 Nov 2026.

---

## Gemini

- **Attestation token on "Flash" (3.8).** Since 10 Nov 2026 the web app sends a page-generated attestation token with
  each message for the Flash model, and answers automated-browser Flash requests with canned error/refusal messages.
  The gateway marks `flash` unavailable rather than trying to produce that token. `flash-lite`, `pro`, and `argon`
  are not gated this way and work.
- Plan tier (Free / Plus / Advanced) does not change this: Flash stays walled, and the Ultra-only "Carbon" model is
  an upsell the account does not hold. A Plus/Advanced account's benefit is larger quota, not new usable models.

**ID:** Sejak 10 Nov 2026, model **Flash (3.8)** mewajibkan token atestasi buatan-halaman; request Flash dari browser
otomatis dibalas pesan error/penolakan. Gateway menandai `flash` tidak tersedia, tidak mencoba membuat tokennya.
`flash-lite`, `pro`, `argon` tidak terkena dan berjalan. Paket (Free/Plus) tidak mengubah ini — manfaat Plus adalah
kuota lebih besar, bukan model baru yang bisa diotomasi.

## Claude

- **Cloudflare bot check.** After roughly 35 requests in about an hour on one account, claude.ai starts answering with
  a Cloudflare interstitial. Findings: the check is tied to the **account/session**, not the browser fingerprint (a
  second account kept working in the same browser while the first was blocked); it lasts **more than an hour**.
- The gateway does not try to get past it. On a bot check it fails the request with HTTP 503 and **pauses that
  account** (10 minutes, doubling up to 1 hour; `bot_check_pause`), so it never hammers the challenge.
- Usage limits are reported per answer (5 h / 7 d windows) and shown by `bridge status`; when the limit is reached,
  requests fail with HTTP 429.

**ID:** Setelah ±35 request dalam ±1 jam pada satu akun, claude.ai menampilkan pemeriksaan bot Cloudflare. Temuan:
pemeriksaan terikat **akun/sesi**, bukan sidik jari browser (akun kedua tetap jalan di browser yang sama saat akun
pertama diblokir), dan berlangsung **lebih dari satu jam**. Gateway tidak mencoba melewatinya: request gagal 503 dan
akun **dijeda** (10 menit, berlipat sampai 1 jam). Batas pemakaian dilaporkan per jawaban (jendela 5 jam / 7 hari).

## ChatGPT — the most resistant / paling resisten

ChatGPT defends its web app in **three layers**, so the gateway treats it as best-effort only:

1. **Cloudflare** in front of the site.
2. **Page-generated proof-of-work ("sentinel").** The message endpoint `/backend-api/f/conversation` requires a token
   the page computes from a challenge (`/backend-api/sentinel/chat-requirements/prepare`). A request mode (in-page
   fetch) is therefore impossible without forging that proof-of-work, which the gateway will not do. So ChatGPT is
   **mode C only** — the prompt is typed into the real composer and the answer read from the page, exactly as a person
   does; the page computes its own proof-of-work legitimately.
3. **The session does not hold in an automated browser.** Even with the `__Secure-next-auth.session-token` cookies
   present, `/backend-api/me` returns an anonymous `guest` account (id `ua-…`, empty email) after a while — a login
   that answered live decayed to `guest` within hours, and a fresh login in the automated browser produced only a
   `guest` session. This is session-layer anti-automation; the gateway does not try to defeat it.

**Consequence:** ChatGPT (Free and Go alike) is **not reliably usable** through the gateway. It can answer briefly
right after a hand-login, then the session invalidates. For real, dependable use, the **official OpenAI API** is the
right path (9router supports it directly). The web adapter is kept for research — to observe these protections — not
as a dependable backend.

**ID:** ChatGPT bertahan dalam **tiga lapis**: Cloudflare; **proof-of-work buatan halaman ("sentinel")** pada endpoint
pesan, sehingga mode request mustahil tanpa memalsukannya (gateway menolak memalsukan) — maka ChatGPT **hanya mode C**;
dan **sesi yang tidak bertahan di browser otomatis** — `/backend-api/me` jadi `guest` (id `ua-…`, email kosong)
walau cookie session-token ada; login yang tadinya menjawab meluruh jadi `guest` dalam hitungan jam, dan login baru di
browser otomatis hanya menghasilkan sesi `guest`. **Akibatnya ChatGPT tidak andal lewat gateway** (free maupun Go);
hanya menjawab sebentar setelah login manual. Untuk pemakaian andal, pakai **API resmi OpenAI** (didukung 9router
langsung). Adapter web disimpan untuk keperluan penelitian, bukan sebagai backend andalan.

---

## Principle / Prinsip

The gateway operates only through the real page in the user's own browser profile, as a person would, and **stops at
every protection** — bot checks, proof-of-work, attestation tokens, expired or guest sessions — reporting them as
findings. It does not forge tokens, solve challenges, or tune the browser to look less automated. Where a provider
blocks automated use, that is the answer the gateway returns.

Gateway hanya bekerja lewat halaman asli di profil browser pengguna, seperti manusia, dan **berhenti di setiap
pertahanan** — pemeriksaan bot, proof-of-work, token atestasi, sesi kedaluwarsa/guest — lalu melaporkannya. Tidak
memalsukan token, tidak menyelesaikan tantangan, tidak menyetel browser agar tampak kurang otomatis. Di mana provider
memblokir pemakaian otomatis, itulah jawaban yang dikembalikan gateway.
