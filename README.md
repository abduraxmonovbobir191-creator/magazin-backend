# Magazin Backend

O‘zbekiston oziq-ovqat magazini uchun POS, ombor, moliya va Telegram admin bot API.

## Talablar
- Node.js 20+
- PostgreSQL 15+
- Telegram bot token (ixtiyoriy)

## Ishga tushirish
1. `cp .env.example .env` va maxfiy qiymatlarni to‘ldiring.
2. Infrastructure repodagi `db/schema.sql` ni PostgreSQL bazasida ishga tushiring.
3. `npm install`
4. `npm run build`
5. `npm start`

Development: `npm run dev`

## Endpointlar
- `GET /health` — server va DB holati
- `POST /api/auth/login` — JWT login
- `GET /api/dashboard` — asosiy ko‘rsatkichlar
- `GET/POST /api/products` — mahsulotlar
- `GET/POST /api/expenses` — xarajatlar
- `GET/POST /api/debts` — qarzlar
- `POST /api/debts/:id/payments` — qarz to‘lovi

Himoyalangan endpointlar uchun `Authorization: Bearer <token>` talab qilinadi.

## Muhim
Bu dastlabki MVP asosidir. Ishlab chiqarishga chiqarishdan oldin migration, audit, rate limiting, avtomatik testlar, restore sinovi, fiskal kassa integratsiyasi va O‘zbekiston soliq talablariga muvofiqlik tekshiruvi zarur. Birinchi administrator parolini xavfsiz bootstrap jarayoni orqali yarating; ommaviy default parol ishlatmang.
