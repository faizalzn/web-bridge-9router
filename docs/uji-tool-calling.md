# Manual tool-calling test through Hermes

A fixed set of ten tasks to measure how reliably a model calls tools through the gateway. Send them in order, in
one chat (start with `/new`), from Telegram or the Hermes CLI. Everything happens inside the folder `uji-tool`.

Pass = the task is really done (check the file or output yourself) **and** the gateway log line
`reply <model>: … tool calls: <names>` shows a real tool call where one was needed. A reply that only *claims* the
work was done, with `tool calls: none`, is a fail.

| # | Prompt | Checks |
|---|---|---|
| 1 | `Buat folder uji-tool, lalu buat file uji-tool/halo.txt berisi tulisan: halo dunia` | write a file |
| 2 | `Baca isi file uji-tool/halo.txt dan sebutkan isinya persis.` | read a file |
| 3 | `Ubah isi uji-tool/halo.txt menjadi: halo gemini` | edit a file |
| 4 | `Jalankan perintah python --version dan beri tahu hasilnya.` | run a shell command |
| 5 | `Buat uji-tool/hitung.py yang mencetak jumlah bilangan 1 sampai 100, lalu jalankan dan beri tahu hasilnya.` | two steps; answer must be 5050 |
| 6 | `Tampilkan daftar semua file di folder uji-tool.` | list files |
| 7 | `Buat uji-tool/data.csv berisi kolom nama,umur dengan tiga baris: Ani 20, Budi 30, Citra 40. Lalu hitung rata-rata umur dengan skrip Python dan beri tahu hasilnya.` | multi-step; answer must be 30 |
| 8 | `Cari kata "gemini" di semua file dalam folder uji-tool dan sebutkan file mana saja yang memuatnya.` | search; answer: halo.txt |
| 9 | `Apa ibu kota Jepang? Jawab langsung tanpa memakai tool apa pun.` | must answer Tokyo with `tool calls: none` |
| 10 | `Hapus file uji-tool/data.csv, lalu pastikan file itu sudah tidak ada.` | delete and verify |

## Results

| Date | Model | Passed | Notes |
|---|---|---|---|
| 2026-11-11 | claude/sonnet (claude.ai Free) | 10/10 | Hermes had no bash (`HERMES_GIT_BASH_PATH` not loaded yet), so `write_file`/`read_file` failed and the model switched to `execute_code` by itself and said so. Every step was a real tool call in the gateway log; #9 had `tool calls: none`. 24 requests, 3.4–7.4 s each. 5h quota 5% → 21%, 7d 1%. The second request started a new chat instead of continuing (cause not known yet). One stream was ended by the client after 4.8 s (Hermes: "Clean EOF, no finish_reason"); Hermes retried and the task finished. |
