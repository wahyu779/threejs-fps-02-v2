# Pelabuhan Senja v2 — Tactical FPS (three.js)

FPS taktis berbasis ronde di pelabuhan saat senja. Tim Senja (penyerang, 5 orang
termasuk kamu) melawan tim Bayang (bertahan, 5 orang) di peta 40×40 meter dengan
dua situs bom, A di gudang barat-laut dan B di kantor dermaga tenggara.

## Cara main

Buka `game/index.html` lewat server statis (`node serve.ts`, lalu
http://localhost:8080) — gamenya murni file statis, tanpa network.

- WASD gerak, mouse membidik (klik untuk pointer lock), klik kiri menembak
- R reload, B buka menu beli (fase persiapan), E tanam / jinakkan bom
- G lempar granat, Ctrl/C jongkok, Spasi lompat, 1 ganti ke pistol

Menang ronde dengan menghabisi tim musuh, meledakkan bom yang ditanam
(tanam 3 detik, sumbu 40 detik), atau — untuk Bayang — menjinakkan bom
(5 detik) dan bertahan sampai waktu habis. Pertama ke 5 ronde menang.

## Yang baru di v2

- **Hitscan beneran**: tiap tembakan adalah ray melawan hitbox badan
  (kepala ×2 damage), bukan lempar dadu. Bot dan pemain pakai sistem yang sama.
- **Recoil + spread**: tiap senjata punya pola recoil yang bisa dipelajari;
  spread membesar saat bergerak / melompat, mengecil saat diam / jongkok.
- **Armor + loss-streak**: Rompi Kevlar $650 menyerap 50% damage; tim yang
  kalah beruntun dapat bonus uang yang membesar ($1900 → $3400).
- **5v5 + A\***: pathfinding A* di grid peta dengan path smoothing, bukan
  waypoint BFS; 5 lawan 5.
- **Bot strafe**: bot bergerak lateral sambil menembak saat duel.
- **Minimap live**: posisi tim, musuh yang terlihat / terdengar, dan bom.

## Mode untuk pengujian

- `?sim=1` — semua pemain dikendalikan AI, ronde jalan sendiri (untuk A/B).
- `?selftest=1` — cek unit deterministik (hitscan, spread, armor, loss-streak,
  A*, recoil, LOS), hasilnya di `#selftest` dan `window.__selftest`.
- `?pose=start|combat|plant|end` — staging untuk screenshot.

## Lisensi

MIT — lihat LICENSE.
